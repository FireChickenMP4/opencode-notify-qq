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

import { writeFileSync } from "node:fs";
import { configPath, loadConfig } from "./config";
import { QqBotClient, getAccessToken, sendMarkdown, sendText, type GatewayEvent } from "./qqbot";
import { SessionNumbers, sessionNumbersPath } from "./sessions";
import { TaskQueue } from "./task-queue";

const BASE = (process.env.OPENCODE_SERVER_URL?.trim() || "http://127.0.0.1:4096").replace(
  /\/$/,
  "",
);

/**
 * TCP port used purely as a single-instance lock. Not a service; any connection
 * attempt is ignored. Chosen to sit next to opencode's 4096 default.
 */
const LOCK_PORT = Number(process.env.OPENCODE_NOTIFY_QQ_LOCK_PORT ?? 4097);

/**
 * Records this bridge's identity ({pid, hash}) so the plugin can tell whether
 * the running daemon is from the current source. Without it, a bridge spawned
 * detached from an older build is reused forever (the lock port makes startup
 * idempotent), and every bridge change needs a manual kill.
 */
const STATE_PATH = process.env.OPENCODE_NOTIFY_QQ_BRIDGE_STATE;

function writeState(): void {
  if (!STATE_PATH) return;
  try {
    writeFileSync(
      STATE_PATH,
      JSON.stringify({
        pid: process.pid,
        hash: process.env.OPENCODE_NOTIFY_QQ_BRIDGE_HASH ?? "",
        startedAt: Date.now(),
      }),
      "utf8",
    );
  } catch {
    /* the state file is an optimization; never block startup on it */
  }
}

function log(message: string): void {
  console.log(`[bridge] ${message}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// opencode HTTP client
// ---------------------------------------------------------------------------

type OpencodeEvent = { id?: string; type?: string; properties?: Record<string, unknown> };
type Session = { id: string; directory?: string; agent?: string; parentID?: string };

let sessions: Session[] | null = null;
let sessionsAt = 0;

/**
 * All sessions, cached briefly.
 *
 * `limit` is raised because the default page (100) is too small to decide which
 * sessions are still alive for numbering reclamation.
 */
async function allSessions(): Promise<Session[]> {
  if (!sessions || Date.now() - sessionsAt > 60_000) {
    const res = await fetch(`${BASE}/session?limit=1000`);
    if (res.ok) {
      sessions = (await res.json()) as Session[];
      sessionsAt = Date.now();
    }
  }
  return sessions ?? [];
}

/** Session list changes rarely; cache it so each permission is one round-trip. */
async function sessionInfo(sessionID: string): Promise<Session> {
  return (await allSessions()).find((s) => s.id === sessionID) ?? { id: sessionID };
}

async function sessionDirectory(sessionID: string): Promise<string> {
  return (await sessionInfo(sessionID)).directory ?? "(unknown)";
}

/** True while the session has a turn running (status "busy" or "retry"). */
async function sessionIsBusy(sessionID: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/session/status`);
    if (!res.ok) return false;
    const all = (await res.json()) as Record<string, { type?: string }>;
    const t = all[sessionID]?.type;
    return t === "busy" || t === "retry";
  } catch {
    // On failure assume idle: injecting is the intent, and a wrong "busy"
    // would silently strand the message.
    return false;
  }
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
  const key = text.trim().replace(/^[.．。]/, "").trim().toLowerCase();
  return REPLY_ALIASES[key];
}

// ---------------------------------------------------------------------------
// Remote commands
// ---------------------------------------------------------------------------

export type Command =
  | { kind: "task" | "ask"; text: string; target?: number }
  | { kind: "stop"; target?: number }
  | { kind: "restart"; target?: number };

/**
 * Parse a leading-dot command. Returns undefined for anything else, so ordinary
 * chatter and o/a/r replies pass through untouched.
 *
 *   .task <text>      inject a message; runs after the current turn
 *   .ask  <text>      same injection (kept as a distinct word for habit)
 *   .stop             abort the running turn (highest priority)
 *   .restart          restart the session's agent loop (abort + continue)
 *
 * Any command may name a session by number: `.stop #2`, `.task #1 do x`. The
 * leading dot accepts ASCII, full-width, or the Chinese ideographic full stop,
 * since a phone IME often produces the last one.
 *
 * Note: both .task and .ask queue after the running turn. opencode has no
 * working "steer into the middle of the current turn" route - the v2 delivery
 * flag is accepted but never honoured (see prompt()).
 */
export function parseCommand(text: string): Command | undefined {
  const m = text.trim().match(/^[.．。]\s*(task|ask|stop|restart)\b\s*([\s\S]*)$/i);
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase() as "task" | "ask" | "stop" | "restart";
  let rest = (m[2] ?? "").trim();

  // Optional leading "#N" target. Stripped before the body is taken, so
  // `.task #2 deploy` has body "deploy" and target 2.
  let target: number | undefined;
  const t = rest.match(/^#\s*(\d+)\b\s*([\s\S]*)$/);
  if (t) {
    target = Number(t[1]);
    rest = (t[2] ?? "").trim();
  }

  if (kind === "stop" || kind === "restart") return { kind, target };
  if (!rest) return undefined; // a bare ".task" with no body is not a command
  return { kind, text: rest, target };
}

/** The session a command should act on: the most recent one we have seen. */
let lastSessionID: string | null = null;

/** Stable short numbers so a phone reply can name a session (shared via file). */
const sessionNumbers = new SessionNumbers(sessionNumbersPath());

/**
 * Messages deferred to the end of the running turn.
 *
 * opencode has no working "deliver after this turn" route: `prompt_async` (the
 * only one that delivers) always steers into the running turn, and the v2
 * `delivery:"queue"` flag is accepted but never honoured. So `.task` - which
 * means "after you finish, do this" - is queued HERE and released when the
 * session reports idle.
 */
const taskQueue = new TaskQueue();

/**
 * Sessions currently being drained. One finished turn emits several idle
 * signals; without this guard two of them would race and send the same queued
 * text twice.
 */
const draining = new Set<string>();

/**
 * Record a session from an event and return its display number.
 *
 * Subagent sessions do not get numbers: they are ephemeral and would inflate
 * the count, and you never need to address one remotely. They still set
 * lastSessionID so untargeted commands hit the session that is actually active.
 */
function rememberSession(sessionID: string): number | undefined {
  lastSessionID = sessionID;
  if (subagentIds.has(sessionID)) return undefined;
  return sessionNumbers.numberFor(sessionID);
}

/** Sessions known to be subagents (have a parentID). */
const subagentIds = new Set<string>();
let registryAt = 0;

/**
 * How many recent main sessions keep a number.
 *
 * Numbers would otherwise climb forever, since every session that ever emitted
 * an event would hold one. Only recent ones matter (you reply to a notification
 * you just received), so older ones are released and their numbers reused.
 */
const NUMBER_WINDOW = Number(process.env.OPENCODE_NOTIFY_QQ_NUMBER_WINDOW ?? 30);

/**
 * Refresh the subagent set and reclaim numbers from stale sessions.
 *
 * Throttled: the session list barely changes, and this runs on every event.
 */
async function refreshSessionRegistry(): Promise<void> {
  if (Date.now() - registryAt < 30_000) return;
  registryAt = Date.now();

  const list = await allSessions();
  if (!list.length) return; // fetch failed; never wipe numbers on empty data

  subagentIds.clear();
  const main = list.filter((s) => {
    if (s.parentID) {
      subagentIds.add(s.id);
      return false;
    }
    return true;
  });
  // Most recently updated main sessions keep their numbers.
  const recent = main
    .sort((a, b) => ((b as { time?: { updated?: number } }).time?.updated ?? 0) - ((a as { time?: { updated?: number } }).time?.updated ?? 0))
    .slice(0, NUMBER_WINDOW)
    .map((s) => s.id);
  sessionNumbers.prune(new Set(recent));
}

/**
 * Fallback target when no event has been seen yet: the most recently updated
 * MAIN session. Without this, `.stop` right after startup says "no known
 * session" even though there is an obvious candidate. Subagents are excluded -
 * aborting one is never what you meant.
 */
async function mostRecentSession(): Promise<string | null> {
  const main = (await allSessions()).filter((s) => !s.parentID);
  const sorted = [...main].sort(
    (a, b) =>
      ((b as { time?: { updated?: number } }).time?.updated ?? 0) -
      ((a as { time?: { updated?: number } }).time?.updated ?? 0),
  );
  return sorted[0]?.id ?? null;
}

/**
 * Resolve which session a command targets.
 *
 * An explicit "#N" wins (and says so when unknown). Otherwise the most recent
 * session we have seen, then the most recently updated one as a startup
 * fallback. `num` is absent only if the target is a subagent, which cannot be
 * named but can still be acted on by an untargeted command.
 */
async function resolveTarget(target?: number): Promise<{ id: string; num?: number } | null> {
  if (target !== undefined) {
    const id = sessionNumbers.resolve(target);
    return id ? { id, num: target } : null;
  }
  const id = lastSessionID ?? (await mostRecentSession());
  if (!id) return null;
  return { id, num: rememberSession(id) };
}

/**
 * Release one queued `.task` for a session whose turn just ended.
 *
 * One at a time: sending starts a new turn, so the next item waits for the next
 * idle. That keeps a burst of `.task` messages in order instead of merging them.
 * If the send fails the item is put back, so a transient error does not lose it.
 */
async function drainQueue(sessionID: string): Promise<void> {
  const text = taskQueue.peek(sessionID);
  if (!text || draining.has(sessionID)) return;
  draining.add(sessionID);
  try {
    await prompt(sessionID, text);
    taskQueue.shift(sessionID);
    const rest = taskQueue.size(sessionID);
    const num = sessionNumbers.lookup(sessionID);
    await sendText(`开始排队任务${num !== undefined ? ` #${num}` : ""}: ${text.slice(0, 80)}`);
    log(`command: task drained (${rest} still pending)`);
  } catch (cause) {
    log(`drain failed, keeping queued: ${cause instanceof Error ? cause.message : cause}`);
  } finally {
    // Hold the guard briefly so the idle burst that triggered this cannot
    // immediately start the next item; the next real idle will.
    setTimeout(() => draining.delete(sessionID), 2000);
  }
}

async function runCommand(cmd: Command): Promise<void> {
  const resolved = await resolveTarget(cmd.target);
  if (!resolved) {
    const why = cmd.target !== undefined ? `未知会话编号 #${cmd.target}` : "没有已知会话";
    await sendText(`${why}，无法执行 .${cmd.kind}`);
    return;
  }
  const { id: target, num } = resolved;
  const tag = `[${num !== undefined ? `#${num} ` : ""}${await sessionDirectory(target)}]`;
  try {
    if (cmd.kind === "stop") {
      await fetch(`${BASE}/session/${target}/abort`, { method: "POST" });
      await sendText(`已中断 ${tag}`);
      log("command: stop");
      return;
    }

    if (cmd.kind === "restart") {
      // No dedicated endpoint; abort then send a continuation prompt.
      await fetch(`${BASE}/session/${target}/abort`, { method: "POST" });
      await sendText(`已中断，正在重启工作流 ${tag}`);
      await prompt(target, "Continue from where you left off. Re-state the plan and resume.");
      log("command: restart");
      return;
    }

    if (cmd.kind === "ask") {
      // .ask means "steer into the running turn"; prompt_async already does that.
      await prompt(target, cmd.text);
      await sendText(`已插话 ${tag}: ${cmd.text.slice(0, 80)}`);
      log("command: ask");
      return;
    }

    // .task means "when you finish, do this". If a turn is running, hold it and
    // release on idle; otherwise there is nothing to wait for, send now.
    if (await sessionIsBusy(target)) {
      const n = taskQueue.push(target, cmd.text);
      await sendText(`已排队 ${tag}（本轮结束后执行，队列 ${n} 条）: ${cmd.text.slice(0, 80)}`);
      log(`command: task queued (${n} pending)`);
      return;
    }
    await prompt(target, cmd.text);
    await sendText(`已发送 ${tag}: ${cmd.text.slice(0, 80)}`);
    log("command: task (idle, sent now)");
  } catch (cause) {
    await sendText(`.${cmd.kind} 失败: ${cause instanceof Error ? cause.message : cause}`);
  }
}

/**
 * The route that actually delivers a message.
 *
 * NOT `/api/session/{id}/prompt`: that v2 route looks canonical (returns an
 * `admittedSeq`) but is a no-op - measured, an admitted prompt never appears in
 * the session even while a turn is running. `prompt_async` delivers and starts
 * the session if idle. Exported so the choice is locked by a test.
 */
export function promptPath(sessionID: string): string {
  return `/session/${sessionID}/prompt_async`;
}

/**
 * Inject a message into a session via `promptPath`.
 *
 * The session's own agent is passed explicitly. opencode would otherwise fall
 * back to the last user message's agent (or the default "build"), which means a
 * `.task` into a "yolo" session could suddenly start asking for permissions.
 * Reusing the session's agent keeps the run in the mode you were already in.
 */
async function prompt(sessionID: string, text: string): Promise<void> {
  const agent = (await sessionInfo(sessionID)).agent;
  const payload = { parts: [{ type: "text", text }], ...(agent ? { agent } : {}) };
  const res = await fetch(`${BASE}${promptPath(sessionID)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) return;
  const fallback = await fetch(`${BASE}/session/${sessionID}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!fallback.ok) throw new Error(`HTTP ${res.status} then ${fallback.status}`);
}

const CONFIRM: Record<Verdict, string> = {
  once: "已批准 once",
  always: "已批准 always(记住)",
  reject: "已拒绝 reject",
};

/**
 * Render a permission request for QQ.
 *
 * QQ markdown has no code-block rendering for the shapes we tried, but it does
 * render fenced blocks with a language (verified: ` ```sh ` gets a block+highlight).
 * A raw bash command dumped as one line is unreadable on a phone, so the command
 * goes into a fenced block.
 *
 * For external_directory the command is NOT the point - what you are granting is
 * the DIRECTORY. The plain `patterns` line tells you the exact scope that
 * "always" will remember, which a command cannot convey.
 *
 * Pure and exported so the layout is testable.
 */
export function formatPermission(
  directory: string,
  permission: string,
  metadata: Record<string, unknown>,
  patterns: string[],
  sessionNum?: number,
): string {
  const header = sessionNum !== undefined ? `**需要授权 · #${sessionNum}**` : `**需要授权**`;
  const lines = [header, `目录: \`${directory}\``, `工具: **${permission}**`];

  if (permission === "external_directory") {
    const dirs = Array.isArray(metadata.directories) ? metadata.directories.map(String) : [];
    const command = typeof metadata.command === "string" ? metadata.command : "";
    if (dirs.length) {
      lines.push("", "访问目录:");
      for (const d of dirs) lines.push(`- \`${d}\``);
    }
    if (patterns.length) {
      lines.push("", "记住(always)范围:");
      for (const p of patterns) lines.push(`- \`${p}\``);
    }
    if (command) lines.push("", "命令:", "```sh", command.trim(), "```");
  } else {
    const command =
      (typeof metadata.command === "string" && metadata.command) ||
      (typeof metadata.filePath === "string" && metadata.filePath) ||
      (typeof metadata.filepath === "string" && metadata.filepath) ||
      (patterns.length ? patterns.join(" ") : "(no detail)");
    lines.push("", "```sh", String(command).trim(), "```");
  }

  lines.push("", "回复  **.o**=once  **.a**=always(记住)  **.r**=reject");
  return lines.join("\n");
}

async function handleOpencodeEvent(event: OpencodeEvent): Promise<void> {
  try {
    // Keep the subagent set and number reclamation current before any numbering
    // decision (throttled internally).
    await refreshSessionRegistry();

    // Track the most recent session from ANY event, not just permissions:
    // `.stop` / `.task` need a target even when no permission has fired. The
    // number it returns is what the notification shows and a reply can name.
    const anySessionID = event.properties?.sessionID;
    if (typeof anySessionID === "string" && anySessionID) rememberSession(anySessionID);

    // Release any .task held for this session once its turn ends.
    if (
      event.type === "session.status" &&
      typeof anySessionID === "string" &&
      (event.properties?.status as { type?: string } | undefined)?.type === "idle"
    ) {
      await drainQueue(anySessionID);
    }

    if (event.type !== "permission.updated" && event.type !== "permission.asked") return;
    const p = event.properties ?? {};
    const requestID = typeof p.id === "string" ? p.id : undefined;
    if (!requestID || pending.has(requestID)) return;

    const permission = typeof p.permission === "string" ? p.permission : "unknown";
    const patterns = Array.isArray(p.patterns) ? p.patterns.map(String) : [];
    const metadata = (p.metadata ?? {}) as Record<string, unknown>;

    const sessionID = typeof p.sessionID === "string" ? p.sessionID : "";
    const directory = await sessionDirectory(sessionID);
    const num = sessionID ? rememberSession(sessionID) : undefined;

    pending.set(requestID, { requestID, sessionID, permission });
    await sendMarkdown(formatPermission(directory, permission, metadata, patterns, num));
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
  writeState();

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
