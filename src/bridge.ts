/**
 * bridge: single-process daemon for remote permission approval over QQ.
 *
 * It holds the one and only QQ gateway (WSS) connection, subscribes to the
 * opencode server's SSE stream, pushes pending permission requests to QQ, and
 * maps a one-letter QQ reply back to `POST /permission/{id}/reply`.
 *
 * Only one process may hold the WSS connection: a second Identify on the same
 * shard triggers `op 9 Invalid Session` and kicks the older one (see PLAN.md
 * §4.4). Run exactly one bridge.
 *
 * Usage:
 *   bun run src/bridge.ts            # start the daemon
 *   bun run src/bridge.ts --check    # verify config + token + server, then exit
 *   bun run src/bridge.ts --help
 */

import { configPath, loadConfig } from "./config";
import { QqBotClient, getAccessToken, sendText, type GatewayEvent } from "./qqbot";

const BASE = (process.env.OPENCODE_SERVER_URL?.trim() || "http://127.0.0.1:4096").replace(
  /\/$/,
  "",
);

/**
 * TCP port used purely as a single-instance lock. Not a service; any connection
 * attempt is ignored. Chosen to sit next to opencode's 4096 default.
 */
const LOCK_PORT = Number(process.env.OPENCODE_NOTIFY_QQ_LOCK_PORT ?? 4097);

function log(message: string): void {
  console.log(`[bridge] ${message}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// opencode HTTP client
// ---------------------------------------------------------------------------

type OpencodeEvent = { id?: string; type?: string; properties?: Record<string, unknown> };
type Session = { id: string; directory?: string };

let sessions: Session[] | null = null;
let sessionsAt = 0;

/** Session list changes rarely; cache it so each permission is one round-trip. */
async function sessionDirectory(sessionID: string): Promise<string> {
  if (!sessions || Date.now() - sessionsAt > 60_000) {
    const res = await fetch(`${BASE}/session`);
    if (res.ok) {
      sessions = (await res.json()) as Session[];
      sessionsAt = Date.now();
    }
  }
  return sessions?.find((s) => s.id === sessionID)?.directory ?? "(unknown)";
}

// ---------------------------------------------------------------------------
// Pending requests
// ---------------------------------------------------------------------------

type Pending = { requestID: string; sessionID: string; permission: string };

const pending = new Map<string, Pending>();

type Verdict = "once" | "always" | "reject";

/**
 * Tolerant reply parsing. Accepts, case-insensitively and ignoring a leading
 * `.` or full-width `.`:
 *   o / once / 批准      -> once
 *   a / always / 记住    -> always
 *   r / reject / 拒绝    -> reject
 * A leading dot lets these collide-free with the future `.task` / `.ask`
 * command family.
 */
const REPLY_ALIASES: Record<string, Verdict> = {
  o: "once",
  once: "once",
  批准: "once",
  同意: "once",
  a: "always",
  always: "always",
  记住: "always",
  总是: "always",
  r: "reject",
  reject: "reject",
  拒绝: "reject",
};

export function parseReply(text: string): Verdict | undefined {
  const key = text.trim().replace(/^[.．]/, "").trim().toLowerCase();
  return REPLY_ALIASES[key];
}

// ---------------------------------------------------------------------------
// Remote commands
// ---------------------------------------------------------------------------

export type Command =
  | { kind: "task" | "ask"; text: string }
  | { kind: "stop" }
  | { kind: "restart" };

/**
 * Parse a leading-dot command. Returns undefined for anything else, so ordinary
 * chatter and o/a/r replies pass through untouched.
 *
 *   .task <text>     queue a task; runs after the current turn
 *   .ask  <text>     light interjection; steers immediately; same as .task when idle
 *   .stop            abort the running turn (highest priority)
 *   .restart         restart the session's agent loop (abort + continue)
 */
export function parseCommand(text: string): Command | undefined {
  const m = text.trim().match(/^[.．]\s*(task|ask|stop|restart)\b\s*([\s\S]*)$/i);
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase() as "task" | "ask" | "stop" | "restart";
  const rest = (m[2] ?? "").trim();
  if (kind === "stop" || kind === "restart") return { kind };
  if (!rest) return undefined; // a bare ".task" with no body is not a command
  return { kind, text: rest };
}

/** The session a command should act on: the most recent one we have seen. */
let lastSessionID: string | null = null;

/**
 * Fallback target when no event has been seen yet: the most recently updated
 * session. Without this, `.stop` right after startup says "no known session"
 * even though there is an obvious candidate.
 */
async function mostRecentSession(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/session`);
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ id?: string; time?: { updated?: number } }>;
    const sorted = [...list].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    return sorted[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function runCommand(cmd: Command): Promise<void> {
  const target = lastSessionID ?? (await mostRecentSession());
  if (!target) {
    await sendText(`没有已知会话，无法执行 .${cmd.kind}`);
    return;
  }
  try {
    if (cmd.kind === "stop") {
      await fetch(`${BASE}/session/${target}/abort`, { method: "POST" });
      await sendText(`已中断当前执行 [${await sessionDirectory(target)}]`);
      log("command: stop");
      return;
    }

    if (cmd.kind === "restart") {
      // No dedicated endpoint; abort then send a continuation prompt.
      await fetch(`${BASE}/session/${target}/abort`, { method: "POST" });
      await sendText("已中断，正在重启工作流");
      await prompt(target, "Continue from where you left off. Re-state the plan and resume.");
      log("command: restart");
      return;
    }

    // task = queue for after this turn; ask = steer into it now.
    await prompt(target, cmd.text, cmd.kind === "task" ? "queue" : "steer");
    await sendText(`已${cmd.kind === "task" ? "排队" : "插话"}: ${cmd.text.slice(0, 80)}`);
    log(`command: ${cmd.kind}`);
  } catch (cause) {
    await sendText(`.${cmd.kind} 失败: ${cause instanceof Error ? cause.message : cause}`);
  }
}

/** Inject a prompt into a session. `delivery` decides queue-vs-steer. */
async function prompt(sessionID: string, text: string, delivery?: "queue" | "steer"): Promise<void> {
  const res = await fetch(`${BASE}/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: { text }, ...(delivery ? { delivery } : {}) }),
  });
  // Older builds lack /api/session/{id}/prompt; fall back to the v1 route.
  if (res.ok) return;
  const fallback = await fetch(`${BASE}/session/${sessionID}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  });
  if (!fallback.ok) throw new Error(`HTTP ${res.status} then ${fallback.status}`);
}

const CONFIRM: Record<Verdict, string> = {
  once: "已批准 once",
  always: "已批准 always(记住)",
  reject: "已拒绝 reject",
};

async function handleOpencodeEvent(event: OpencodeEvent): Promise<void> {
  try {
    // Track the most recent session from ANY event, not just permissions:
    // `.stop` / `.task` need a target even when no permission has fired.
    const anySessionID = event.properties?.sessionID;
    if (typeof anySessionID === "string" && anySessionID) lastSessionID = anySessionID;

    if (event.type !== "permission.updated" && event.type !== "permission.asked") return;
    const p = event.properties ?? {};
    const requestID = typeof p.id === "string" ? p.id : undefined;
    if (!requestID || pending.has(requestID)) return;

    const permission = typeof p.permission === "string" ? p.permission : "unknown";
    const patterns = Array.isArray(p.patterns) ? p.patterns.map(String) : [];
    const metadata = (p.metadata ?? {}) as Record<string, unknown>;

    // Which detail matters depends on the permission kind. Measured payloads:
    //   bash               -> metadata.command      (the command itself)
    //   external_directory -> metadata.filepath     (what it wants to touch)
    //   edit/write/read    -> metadata.filePath
    // patterns is the fallback (the always-allow globs).
    const detail = [
      metadata.command,
      metadata.filepath,
      metadata.filePath,
      patterns.length ? patterns.join(" ") : undefined,
    ].find((v) => typeof v === "string" && v.trim()) ?? "(no detail)";

    const sessionID = typeof p.sessionID === "string" ? p.sessionID : "";
    const directory = await sessionDirectory(sessionID);

    pending.set(requestID, { requestID, sessionID, permission });
    await sendText(
      `【需要授权】${directory}\n` +
        `工具: ${permission}\n` +
        `内容: ${String(detail).trim()}\n` +
        `回复 .o=once  .a=always(记住)  .r=reject`,
    );
    log(`permission ${requestID} (${permission}) -> QQ`);
  } catch (cause) {
    log(`failed to handle permission: ${cause instanceof Error ? cause.message : cause}`);
  }
}

async function handleQqEvent(event: GatewayEvent): Promise<void> {
  try {
    if (event.t !== "C2C_MESSAGE_CREATE" && event.t !== "GROUP_AT_MESSAGE_CREATE") return;
    const content = (event.d as { content?: string } | undefined)?.content ?? "";

    // Commands (.task / .ask / .stop / .restart) are checked first: their
    // leading word makes them unambiguous against the o/a/r replies.
    const command = parseCommand(content);
    if (command) {
      await runCommand(command);
      return;
    }

    const reply = parseReply(content);
    if (!reply) return; // unrelated chatter; stay silent

    // FIFO: with several requests waiting, "o" must mean one unambiguous one.
    const target = pending.values().next().value as Pending | undefined;
    if (!target) {
      log(`reply "${content.trim()}" ignored: no pending request`);
      return;
    }
    pending.delete(target.requestID);

    const res = await fetch(`${BASE}/permission/${target.requestID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply }),
    });
    if (!res.ok) throw new Error(`reply failed: HTTP ${res.status}`);

    await sendText(`${CONFIRM[reply]} · ${target.permission}`);
    log(`permission ${target.requestID} -> ${reply}`);
  } catch (cause) {
    log(`failed to handle QQ reply: ${cause instanceof Error ? cause.message : cause}`);
  }
}

// ---------------------------------------------------------------------------
// SSE subscription
// ---------------------------------------------------------------------------

/** Reconnect forever with capped backoff; a dropped stream is expected, not fatal. */
async function subscribeEvents(
  onEvent: (event: OpencodeEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let backoff = 1000;
  let announced = false;
  while (!signal.aborted) {
    try {
      const res = await fetch(`${BASE}/event`, {
        signal,
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      backoff = 1000;
      announced = false;
      log("subscribed to opencode events");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              onEvent(JSON.parse(raw) as OpencodeEvent);
            } catch {
              log("dropped unparseable event frame");
            }
          }
        }
      }
      throw new Error("stream ended");
    } catch (cause) {
      if (signal.aborted) return;
      // Say it once, loudly, because the usual cause is "no opencode serve
      // running at BASE" - which otherwise looks like the bridge doing nothing.
      if (!announced) {
        announced = true;
        log(`cannot reach opencode at ${BASE} - is "opencode serve" running?`);
        log(`(remote approvals need serve + attach, not a plain "opencode")`);
      }
      log(`event stream dropped (${cause instanceof Error ? cause.message : cause}); retry in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function check(): Promise<number> {
  console.log(`config: ${configPath()}`);
  console.log(`opencode: ${BASE}`);

  const cfg = loadConfig();
  if (!cfg.qqbot) {
    console.log("  qqbot: NOT configured (see README)");
    return 2;
  }
  console.log(`  qqbot.appId: ${cfg.qqbot.appId.slice(0, 6)}...`);
  console.log(`  qqbot.notifyTarget: ${cfg.qqbot.notifyTarget ? JSON.stringify(cfg.qqbot.notifyTarget) : "(not set)"}`);

  try {
    const token = await getAccessToken(true);
    console.log(`  token: OK (${token.slice(0, 8)}...)`);
  } catch (cause) {
    console.log(`  token: FAILED - ${cause instanceof Error ? cause.message : cause}`);
    return 1;
  }

  try {
    const res = await fetch(`${BASE}/permission`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as unknown[];
    console.log(`  opencode server: OK (${list.length} pending)`);
  } catch (cause) {
    console.log(`  opencode server: FAILED - ${cause instanceof Error ? cause.message : cause}`);
    return 1;
  }
  return 0;
}

function help(): number {
  console.log(
    [
      "bridge - remote permission approval over QQ",
      "",
      "usage:",
      "  bun run src/bridge.ts            start the daemon",
      "  bun run src/bridge.ts --check    verify config + token + server",
      "  bun run src/bridge.ts --help",
      "",
      "env:",
      "  OPENCODE_SERVER_URL   opencode server base (default http://127.0.0.1:4096)",
    ].join("\n"),
  );
  return 0;
}

async function run(): Promise<number> {
  const cfg = loadConfig();
  if (!cfg.qqbot) {
    console.error("QQ bot not configured. Add a \"qqbot\" section (see README).");
    return 2;
  }

  // Single-instance guard. The QQ gateway allows only one WSS per appId+shard;
  // a second connection kicks the first (op 9). A bound TCP port is the lock:
  // the OS guarantees uniqueness and releases it when the process dies, so
  // there are no stale PID files to reason about.
  let lock: ReturnType<typeof Bun.listen> | null = null;
  try {
    lock = Bun.listen({ hostname: "127.0.0.1", port: LOCK_PORT, socket: { data() {} } });
  } catch {
    console.error(`another bridge is already running (port ${LOCK_PORT} is in use).`);
    console.error(`stop it first, or set OPENCODE_NOTIFY_QQ_LOCK_PORT to a free port.`);
    return 3;
  }

  const client = new QqBotClient({
    onLog: (m) => log(`gateway: ${m}`),
    onEvent: (e) => void handleQqEvent(e),
  });
  try {
    await client.connect();
  } catch (cause) {
    console.error(`failed to start: ${cause instanceof Error ? cause.message : cause}`);
    lock.stop(true);
    return 1;
  }
  log(`QQ gateway connected (lock port ${LOCK_PORT})`);

  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    client.close();
    lock?.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await subscribeEvents((e) => void handleOpencodeEvent(e), abort.signal);
  return 0;
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (arg === "--check") return check();
  if (arg === "--help" || arg === "-h") return help();
  if (arg) {
    console.error(`unknown option: ${arg} (try --help)`);
    return 2;
  }
  return run();
}

if (import.meta.main) {
  process.exit(await main());
}
