/**
 * QQ notifications for opencode. Two independent paths:
 *
 *   1. `notify_qq` tool - the agent decides to push (long task, needs a
 *      decision, user said they were stepping out).
 *   2. Idle auto-push - when the turn finishes AND the switch is ON, push
 *      automatically. For "I'm away, ping me when it's done".
 *
 * The idle switch lives in the config file and is read FRESH on every event,
 * so flipping it in the JSON takes effect immediately - no restart, and it
 * works while the agent is busy. A `notify-qq on|off` shell function is
 * installed for convenience (see install.ps1 / README).
 *
 * Setup: credentials + switch in ~/.config/opencode/notify-qq.json (see README).
 */

import { tool, type Plugin } from "@opencode-ai/plugin";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the auto-spawned bridge writes stdout+stderr. */
const BRIDGE_LOG = join(HERE, "bridge.log");

/**
 * File log for the event path.
 *
 * opencode's own log does not record event dispatch, so without this a
 * notification that "should" have fired but did not is invisible. Disable with
 * OPENCODE_NOTIFY_QQ_LOG=0.
 */
function trace(line: string): void {
  if (process.env.OPENCODE_NOTIFY_QQ_LOG === "0") return;
  try {
    appendFileSync(join(HERE, "notify-qq.events.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* diagnostics must never break anything */
  }
}

  type Client = {
    sendText: (m: string) => Promise<{ id?: string }>;
    sendMarkdown: (m: string) => Promise<{ id?: string }>;
    configPath: () => string;
    loadConfig: () => { qqbot?: { notifyTarget?: unknown }; awayNotify: boolean };
    setAwayNotify: (enabled: boolean) => boolean;
    /** Read-only session numbers, shared with the bridge via file. */
    sessionNumber: (sessionID: string) => number | undefined;
    /** Long-running bash watchdog (timer-based). */
    BashWatch: typeof import("../src/bash-watch").BashWatch;
    bashAlert: typeof import("../src/bash-watch").bashAlert;
  };

// The client sources sit next to this file once installed as
// `plugins/notify-qq.ts` + `plugins/notify-qq/`. In the repo they live under
// `src/`, so try both and fail with an actionable message.
async function loadClient(): Promise<Client> {
  const candidates = ["./notify-qq/qqbot.ts", "../src/qqbot.ts"];
  for (const qqbotPath of candidates) {
    try {
      const qqbot = await import(qqbotPath);
      const config = await import(qqbotPath.replace("qqbot.ts", "config.ts"));
      const sessions = await import(qqbotPath.replace("qqbot.ts", "sessions.ts"));
      const watch = await import(qqbotPath.replace("qqbot.ts", "bash-watch.ts"));
      return {
        sendText: qqbot.sendText,
        sendMarkdown: qqbot.sendMarkdown,
        configPath: config.configPath,
        loadConfig: config.loadConfig,
        setAwayNotify: config.setAwayNotify,
        // Re-read each call: the bridge allocates numbers while we run, and this
        // plugin is long-lived, so a cached read would go stale.
        sessionNumber: (sessionID: string) => sessions.readSessionNumbers().lookup(sessionID),
        BashWatch: watch.BashWatch,
        bashAlert: watch.bashAlert,
      };
    } catch {
      continue;
    }
  }
  throw new Error(
    "cannot locate notify-qq client sources. Re-run install.ps1 from the repo root.",
  );
}

/**
 * Make sure the bridge daemon is running *from the current source*.
 *
 * Idempotent by construction: the bridge binds a lock port, so starting a
 * second one simply exits. But that alone would reuse a bridge spawned from an
 * older build forever. So the bridge records {pid, hash} of its source; if the
 * running one's hash differs, we kill it and spawn fresh. This removes the
 * "changed bridge.ts, must kill the old daemon by hand" step.
 *
 * The bridge is spawned detached: it must outlive the opencode process, since
 * its job is to keep serving approvals while you are away. Nothing stops it on
 * plugin dispose, on purpose (another opencode may still be running).
 */
async function ensureBridge(): Promise<void> {
  if (process.env.OPENCODE_NOTIFY_QQ_BRIDGE === "0") return;
  const port = Number(process.env.OPENCODE_NOTIFY_QQ_LOCK_PORT ?? 4097);

  const here = dirname(fileURLToPath(import.meta.url));
  // Installed layout: <plugins>/notify-qq/bridge.ts ; repo layout: <repo>/src/bridge.ts
  const candidates = [join(here, "notify-qq", "bridge.ts"), join(here, "..", "src", "bridge.ts")];
  const script = candidates.find((p) => existsSync(p));
  if (!script) {
    trace(`bridge not started: script not found (${candidates.join(", ")})`);
    return;
  }

  const hash = bridgeHash(script);
  const statePath = bridgeStatePath();

  if (await isPortOpen(port)) {
    if (await runningBridgeIsCurrent(statePath, hash)) {
      trace(`bridge already running (port ${port}, hash ${hash})`);
      return;
    }
    trace(`bridge is stale (hash mismatch); replacing`);
    await stopStaleBridge(statePath, port);
  }

  try {
    const { spawn } = await import("node:child_process");
    const { openSync } = await import("node:fs");
    const logFd = openSync(BRIDGE_LOG, "a");
    const child = spawn("bun", ["run", script], {
      detached: true,
      // Log to a file, not /dev/null: when the bridge misbehaves (bad server
      // URL, gateway conflict) the only way to see why is this output.
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: {
        ...process.env,
        OPENCODE_NOTIFY_QQ_BRIDGE_STATE: statePath,
        OPENCODE_NOTIFY_QQ_BRIDGE_HASH: hash,
      },
    });
    child.unref();
    trace(`bridge spawned pid=${child.pid} (hash ${hash}, log: ${BRIDGE_LOG})`);
  } catch (cause) {
    trace(`bridge spawn failed: ${cause instanceof Error ? cause.message : cause}`);
  }
}

/** Content hash of the bridge entry so a rebuilt daemon can be detected. */
export function bridgeHash(script: string): string {
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(readFileSync(script));
    return hasher.digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

function bridgeStatePath(): string {
  return process.env.OPENCODE_NOTIFY_QQ_BRIDGE_STATE || join(HERE, "bridge.state.json");
}

/** True when the recorded bridge pid is alive and was built from `hash`. */
export async function runningBridgeIsCurrent(statePath: string, hash: string): Promise<boolean> {
  if (!hash) return true; // cannot verify; assume fine rather than churn processes
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { pid?: number; hash?: string };
    if (state.hash !== hash) return false;
    if (!state.pid) return false;
    process.kill(state.pid, 0); // throws if the pid is gone
    return true;
  } catch {
    return false;
  }
}

/** Kill the daemon named in the state file; fall back to whoever holds `port`. */
async function stopStaleBridge(statePath: string, port: number): Promise<void> {
  let pid: number | undefined;
  try {
    pid = (JSON.parse(readFileSync(statePath, "utf8")) as { pid?: number }).pid;
  } catch {
    /* no state file: fall through to the port probe */
  }
  if (pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  } else {
    await killPortHolder(port);
  }
  await new Promise((r) => setTimeout(r, 300)); // let the lock port release
}

/** Last resort when no state file exists: find the pid listening on `port`. */
async function killPortHolder(port: number): Promise<void> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue).OwningProcess`,
    ]);
    const pid = Number(stdout.trim().split(/\s+/)[0]);
    if (pid) process.kill(pid, "SIGKILL");
  } catch {
    /* best effort */
  }
}

/** True when something is listening on the loopback port. */
async function isPortOpen(port: number): Promise<boolean> {
  const attempt = Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: { open() {}, data() {}, close() {}, error() {} },
  });
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 300));
  const result = await Promise.race([attempt.then(() => true).catch(() => false), timeout]);
  return result === true;
}

/**
 * Pick the turn's closing text from a message list.
 *
 * Rule: the LAST assistant message that has text and no tool part. A message
 * that calls a tool is not a conclusion, so it is skipped.
 *
 * Trailing user messages with no reply yet are skipped first. The bridge injects
 * a queued `.task` as a user message the moment the session goes idle - the same
 * moment this runs - so without the skip it hit that message, treated it as the
 * turn boundary, and returned "" (a completion push with no body).
 *
 * Exported for testing: this selection was wrong three times, so it is locked.
 */
export function pickFinalText(
  messages: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>,
): string {
  let start = messages.length - 1;
  // Skip pending trailing user turns (e.g. an injected .task not yet answered).
  while (start >= 0 && messages[start]?.info?.role === "user") start--;

  for (let i = start; i >= 0; i--) {
    const m = messages[i]!;
    if (m.info?.role === "user") break;
    if (m.info?.role !== "assistant") continue;
    const parts = m.parts ?? [];
    if (parts.some((p) => p.type === "tool")) continue;
    const text = parts
      .filter((p) => p.type === "text" && p.text?.trim())
      .map((p) => p.text!.trim())
      .join("\n\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * The most recent thing the agent actually said, even from a tool step.
 *
 * Used only when pickFinalText finds no clean conclusion: an interrupted turn
 * (the last step errored or was aborted) ends on a tool message and has no
 * text-only message at all, so the push would otherwise show no body. A short
 * "let me check X" beats a blank notification.
 *
 * Exported for testing.
 */
export function pickFallbackText(
  messages: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>,
): string {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.info?.role === "user") start--;

  for (let i = start; i >= 0; i--) {
    const m = messages[i]!;
    if (m.info?.role === "user") break;
    if (m.info?.role !== "assistant") continue;
    const texts = (m.parts ?? []).filter((p) => p.type === "text" && p.text?.trim());
    const last = texts[texts.length - 1];
    if (last?.text?.trim()) return last.text.trim();
  }
  return "";
}

/**
 * Tidy the turn's closing text for a push.
 *
 * The input is already the final text-only message, so it is complete and must
 * NOT be trimmed to a headline: an earlier 800-char cap silently cut the tail
 * off ordinary replies. QQ markdown accepts far more (verified >12k chars), so
 * `maxChars` is only a runaway guard.
 *
 * Exported for testing.
 */
export function normalizeFinalText(text: string, maxChars: number): string {
  const body = text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  if (body.length < 4) return "";
  return body.length > maxChars ? `${body.slice(0, Math.max(0, maxChars - 3))}...` : body;
}

export const NotifyQqPlugin: Plugin = async ({ client, directory }) => {
  let api: Client | null = null;
  let loadError: string | null = null;
  try {
    api = await loadClient();
  } catch (cause) {
    loadError = cause instanceof Error ? cause.message : String(cause);
  }

  await ensureBridge();

  const workspace = (() => {
    const dir = directory || process.cwd();
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const short = home && dir.toLowerCase().startsWith(home.toLowerCase()) ? `~${dir.slice(home.length)}` : dir;
    return short.replace(/\\/g, "/");
  })();

  await client.app
    .log({
      body: {
        service: "notify-qq",
        level: loadError ? "warn" : "info",
        message: loadError ?? "notify_qq tool registered",
      },
    })
    .catch(() => {});

  /** Send, swallowing errors so a notification never breaks a session. */
  async function trySend(text: string, markdown = false): Promise<string> {
    if (!api) {
      trace(`send skipped: api not loaded (${loadError})`);
      return `notify_qq unavailable: ${loadError}`;
    }
    try {
      const result = markdown ? await api.sendMarkdown(text) : await api.sendText(text);
      trace(`sent: ${text}`);
      return `sent to QQ (id=${result.id ?? "?"})`;
    } catch (cause) {
      const err = cause as { message?: string; code?: number };
      const code = typeof err?.code === "number" ? ` (code=${err.code})` : "";
      trace(`send FAILED: ${err?.message ?? String(cause)}${code}`);
      return `failed to send: ${err?.message ?? String(cause)}${code}`;
    }
  }

  /** Read the switch fresh - this is what makes the config file the real control. */
  function awayEnabled(): boolean {
    if (!api) return false;
    try {
      return api.loadConfig().awayNotify === true;
    } catch {
      return false;
    }
  }

  /**
   * Retry tracking, keyed by session.
   *
   * The `retry` status carries the attempt count and the next delay. We only
   * warn about a *long* failing streak, and only once per streak, so the state
   * is {start, notified}; it clears when the turn reaches idle.
   */
  const retryStreak = new Map<string, { start: number; notified: boolean }>();
  /** Warn once a streak has been failing this long. */
  const RETRY_NOTIFY_MS = Number(process.env.OPENCODE_NOTIFY_QQ_RETRY_MS ?? 60_000);

  function handleRetry(sessionID: string | undefined, attempt?: number, message?: string): void {
    if (!sessionID) return;
    let streak = retryStreak.get(sessionID);
    if (!streak) {
      streak = { start: Date.now(), notified: false };
      retryStreak.set(sessionID, streak);
    }
    const elapsed = Date.now() - streak.start;
    if (elapsed < RETRY_NOTIFY_MS) {
      trace(`retry attempt ${attempt ?? "?"} (${Math.round(elapsed / 1000)}s < ${RETRY_NOTIFY_MS / 1000}s, quiet)`);
      return;
    }
    if (streak.notified) return; // already warned about this streak
    if (!awayEnabled()) return;
    streak.notified = true;
    const secs = Math.round(elapsed / 1000);
    const detail = message ? `\n\n\`${message.slice(0, 120)}\`` : "";
    void trySend(`**opencode · 重试中**\n\n\`${workspace}\`\n\n已重试 ${attempt ?? "?"} 次，持续约 ${secs}s${detail}`, true);
  }

  /**
   * Suppress duplicates within a short window.
   *
   * One finished turn can emit several `session.status` idle signals in the
   * same second - an ESC interrupt produces a burst. Without this, one
   * end-of-turn becomes two or three QQ messages.
   */
  const DEDUP_MS = Number(process.env.OPENCODE_NOTIFY_QQ_DEDUP_MS ?? 5000);
  const lastSent = new Map<string, number>();

  function shouldSend(kind: string): boolean {
    const now = Date.now();
    const prev = lastSent.get(kind) ?? 0;
    if (now - prev < DEDUP_MS) return false;
    lastSent.set(kind, now);
    return true;
  }

  /**
   * Warn when a bash command has run too long.
   *
   * opencode eventually kills it (120s default), but while you are away nothing
   * says it is stuck - and `retry` only covers model API retries, not the shell.
   * A blocked command emits no more events, so this is timer-based.
   * Disable with OPENCODE_NOTIFY_QQ_BASH_MS=0.
   */
  const BASH_WATCH_MS = Number(process.env.OPENCODE_NOTIFY_QQ_BASH_MS ?? 90_000);
  /** Most recent command text per call, so the alert can show it. */
  const bashCommands = new Map<string, string>();
  const bashWatch =
    BASH_WATCH_MS > 0 && api
      ? new api.BashWatch(BASH_WATCH_MS, {
          schedule: (ms, fn) => setTimeout(fn, ms),
          cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        }, ({ callID, startMs }) => {
          if (!awayEnabled()) return;
          const cmd = bashCommands.get(callID) ?? "";
          void trySend(api!.bashAlert(cmd, Date.now() - startMs), true);
          trace(`bash long: ${cmd.slice(0, 60)}`);
        })
      : null;

  type SessionInfo = { parentID?: string; title?: string };
  const sessionCache = new Map<string, SessionInfo>();

  /** Resolve whether a session is a subagent, and its title. */
  async function sessionInfo(sessionID: string): Promise<SessionInfo> {
    const cached = sessionCache.get(sessionID);
    if (cached) return cached;
    try {
      const res = await client.session.get({ path: { id: sessionID } });
      const data = (res as { data?: SessionInfo }).data;
      const info: SessionInfo = { parentID: data?.parentID, title: data?.title };
      sessionCache.set(sessionID, info);
      return info;
    } catch {
      return {};
    }
  }

  /** Drop the "(@general subagent)" tail and cap length. */
  function shortTitle(title: string | undefined): string {
    if (!title) return "子代理";
    return title.replace(/\s*\(@\w+\s+subagent\)\s*$/i, "").trim().slice(0, 60) || "子代理";
  }

  /**
   * The assistant's closing text for the turn that just ended.
   *
   * The wrap-up is the LAST assistant message that has text but NO tool part.
   * Two wrong guesses preceded this:
   *   - "last message with text": often a tool-call step whose only text is a
   *     one-line preamble, so the push showed a fragment.
   *   - "collect all text this turn and truncate the head": produced a
   *     "...(前略)" marker and glued preambles to the answer.
   * See pickFinalText for the rule.
   *
   * Reads the transcript rather than calling /summarize (another model turn,
   * slow and costly) since the answer is already written.
   */
  async function lastAssistantText(sessionID: string): Promise<string> {
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      const messages = (res as { data?: Parameters<typeof pickFinalText>[0] }).data;
      if (!Array.isArray(messages)) return "";
      // Prefer the clean conclusion; fall back to the last thing said (a
      // fragmented sentence) so an interrupted turn still shows a body.
      return pickFinalText(messages) || pickFallbackText(messages);
    } catch {
      return "";
    }
  }

  /**
   * Normalize the closing text for a push.
   *
   * The input is already the turn's final text-only message, so it is complete
   * and must NOT be trimmed to a headline: an earlier 800-char cap silently cut
   * the tail off ordinary replies ("...notify-qq ..."). QQ markdown accepts far
   * more (verified >12k chars), so the cap is only a runaway guard, raised and
   * overridable.
   */
  const MAX_CHARS = Number(process.env.OPENCODE_NOTIFY_QQ_MAX_CHARS ?? 4000);

  function headline(text: string): string {
    return normalizeFinalText(text, MAX_CHARS);
  }

  return {
    event: async ({ event }) => {
      const type = event.type;

      // Bash watchdog: track tool parts so a stuck command is noticed.
      if (type === "message.part.updated") {
        const part = (event as { properties?: { part?: { type?: string; tool?: string; callID?: string; state?: { status?: string; time?: { start?: number }; input?: { command?: string } } } } }).properties?.part;
        if (part?.type === "tool" && part.tool === "bash" && part.callID && bashWatch) {
          const cmd = part.state?.input?.command;
          if (cmd) bashCommands.set(part.callID, cmd);
          bashWatch.observe({
            callID: part.callID,
            status: part.state?.status ?? "running",
            startMs: part.state?.time?.start,
          });
          if (part.state?.status === "completed" || part.state?.status === "error") {
            bashCommands.delete(part.callID);
          }
        }
        return;
      }

      if (type !== "permission.asked" && type !== "session.status") return;
      trace(`event:${type}`);

      // A permission request means the agent is BLOCKED and cannot proceed
      // without you. This is the most important "come back" signal, so it is
      // sent even though it is not "completion".
      if (type === "permission.asked") {
        if (!awayEnabled()) {
          trace("permission skipped: awayNotify is off");
          return;
        }
        // The bridge sends a richer permission notice (with .o/.a/.r options).
        // Avoid double-posting the same request.
        if (await isPortOpen(Number(process.env.OPENCODE_NOTIFY_QQ_LOCK_PORT ?? 4097))) {
          trace("permission skipped: bridge is running and will notify");
          return;
        }
        if (!shouldSend("permission")) {
          trace("permission skipped: dedup");
          return;
        }
        await trySend(`opencode · 需要授权 [${workspace}]`);
        return;
      }

      // V2 signals "done" via session.status with status.type === "idle".
      const props = (event as { properties?: { sessionID?: string; status?: { type?: string; attempt?: number; message?: string; next?: number } } }).properties;

      // A retry means the model call failed and is being re-attempted. A single
      // retry is normal and must not wake you; only a streak that keeps failing
      // long enough is worth a message. Notify once per streak.
      if (props?.status?.type === "retry") {
        handleRetry(props.sessionID, props.status.attempt, props.status.message);
        return;
      }
      if (props?.status?.type !== "idle") return;
      // A turn that ends clears any retry streak for the session.
      if (props.sessionID) retryStreak.delete(props.sessionID);

      // Subagents finish while the main session keeps working; reporting them
      // as "done" is misleading and noisy. Off unless explicitly enabled.
      if (props.sessionID) {
        const info = await sessionInfo(props.sessionID);
        if (info.parentID) {
          if (process.env.OPENCODE_NOTIFY_SUBAGENT !== "1") {
            trace(`idle skipped: subagent (${shortTitle(info.title)})`);
            return;
          }
          if (!awayEnabled()) return;
          if (!shouldSend("subagent")) return;
          await trySend(`opencode · 子代理完成 [${shortTitle(info.title)}]`);
          return;
        }
      }

      if (!awayEnabled()) {
        trace("idle skipped: awayNotify is off");
        return;
      }
      if (!shouldSend("idle")) {
        trace("idle skipped: dedup");
        return;
      }

      // Include a headline so the push says WHAT finished, not just "done".
      // Disable with OPENCODE_NOTIFY_QQ_SUMMARY=0 for the old bare message.
      const wantSummary = process.env.OPENCODE_NOTIFY_QQ_SUMMARY !== "0";
      const summary = wantSummary && props.sessionID ? headline(await lastAssistantText(props.sessionID)) : "";
      // Show the session number so a reply can name it (`.stop #2`). The number
      // is allocated by the bridge; if the bridge never saw this session yet,
      // omit rather than invent one.
      const num = props.sessionID ? api?.sessionNumber(props.sessionID) : undefined;
      const heading = num !== undefined ? `**opencode · 完成 · #${num}**` : `**opencode · 完成**`;
      // Markdown so the heading and body render instead of collapsing into one
      // run-on line.
      const md = summary
        ? `${heading}\n\n\`${workspace}\`\n\n---\n\n${summary}`
        : `${heading}\n\n\`${workspace}\``;
      await trySend(md, true);
    },

    tool: {
      notify_qq: tool({
        description:
          "Send a short message to the user's QQ. Use when the user is away or explicitly asked " +
          "to be notified (long task finished, a decision is needed). Returns the send result.",
        args: {
          message: tool.schema.string().describe("message text to send"),
        },
        async execute(args) {
          return trySend(args.message);
        },
      }),

      qq_switch: tool({
        description:
          "Read or change whether opencode pushes QQ while you are away " +
          "(turn finished or a permission is waiting). status=true reports; otherwise set enabled.",
        args: {
          enabled: tool.schema.boolean().optional().describe("new state for away auto-push"),
          status: tool.schema.boolean().optional().describe("report the current state instead of changing it"),
        },
        async execute(args) {
          if (!api) return `unavailable: ${loadError}`;
          try {
            if (args.status) {
              const cfg = api.loadConfig();
              const hasTarget = Boolean(cfg.qqbot?.notifyTarget);
              return `away auto-push: ${cfg.awayNotify ? "ON" : "OFF"} | target configured: ${hasTarget ? "yes" : "no"} | config: ${api.configPath()}`;
            }
            if (typeof args.enabled === "boolean") {
              const now = api.setAwayNotify(args.enabled);
              return `away auto-push is now ${now ? "ON" : "OFF"} (takes effect immediately)`;
            }
            return "nothing to do: pass status=true or enabled=<bool>";
          } catch (cause) {
            return `failed: ${cause instanceof Error ? cause.message : String(cause)}`;
          }
        },
      }),
    },
  };
};
