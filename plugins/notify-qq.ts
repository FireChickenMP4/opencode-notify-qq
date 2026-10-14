/**
 * QQ notifications for opencode. Two independent paths:
 *
 *   1. `notify_qq` tool - the agent decides to push (long task, needs a
 *      decision, user said they were stepping out).
 *   2. Turn-end auto-push - when the turn finishes AND the switch is ON, push
 *      automatically. For "I'm away, ping me when it's done".
 *
 * The switch lives in the config file and is read FRESH on every event, so
 * flipping it in the JSON takes effect immediately - no restart, and it works
 * while the agent is busy. A `notify-qq on|off` shell function is installed for
 * convenience (see install.ps1 / README).
 *
 * Setup: credentials + switch in ~/.config/opencode/notify-qq.json (see README).
 */

import type { Plugin } from "@opencode/plugin";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Pure helpers live in a sibling module (repo `../src`, installed `./notify-qq/`)
 * so this file keeps a single default export. Both layouts are tried, like
 * loadClient below.
 */
const {
  bridgeHash,
  runningBridgeIsCurrent,
  pickFinalText,
  pickFallbackText,
  normalizeFinalText,
} = await (async (): Promise<typeof import("../src/notify-helpers.ts")> => {
  for (const p of ["./notify-qq/notify-helpers.ts", "../src/notify-helpers.ts"]) {
    try {
      return (await import(p)) as typeof import("../src/notify-helpers.ts");
    } catch {
      continue;
    }
  }
  throw new Error("notify-qq: cannot locate notify-helpers.ts");
})();

/**
 * Consume "this turn is a remote command's result" marks.
 *
 * Missing module (older install) degrades to the away switch deciding, which is
 * the pre-existing behaviour.
 */
const takeCommandOutcome = await (async (): Promise<(sessionID: string) => boolean> => {
  for (const p of ["./notify-qq/command-outcome.ts", "../src/command-outcome.ts"]) {
    try {
      const mod = (await import(p)) as { takeCommandOutcome: (id: string) => boolean };
      return mod.takeCommandOutcome;
    } catch {
      continue;
    }
  }
  return () => false;
})();

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

/**
 * Shape of the events this plugin reads. V2 carries every payload under `data`
 * (V1 used `properties`), and only the fields actually used are declared here.
 */
type NotifyEvent = {
  type: string;
  /** The location the event was published for; the session's own directory. */
  location?: { directory?: string };
  data?: {
    id?: string;
    sessionID?: string;
    status?: { type?: string };
    /** Why a step ended; anything but "tool-calls" means the turn is over. */
    finish?: string;
    /** `session.retry.scheduled`: which attempt, and what failed. */
    attempt?: number;
    error?: { type?: string; message?: string };
    /** Tool events: `called` carries the input, all of them carry the call id. */
    input?: { command?: string };
  };
};

/**
 * Path of the CLI settings file, where automatic approval of permission
 * requests is configured.
 */
function cliConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "opencode", "cli.json");
}

/**
 * True when the CLI answers permission requests on its own.
 *
 * Only then can a request be resolved before a human ever sees it, which is the
 * one case where "需要授权" would be noise. Read fresh, so flipping the setting
 * takes effect without a restart.
 */
function autoAcceptEnabled(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(cliConfigPath(), "utf8")) as { session?: { permissions?: unknown } };
    const mode = cfg.session?.permissions;
    return typeof mode === "string" && mode.toLowerCase().replace(/[-_]/g, "") === "autoaccept";
  } catch {
    // Unreadable settings: assume requests are answered by hand, so notify at once.
    return false;
  }
}

/** Only notify about a permission that is still unanswered after this long. */
const PERMISSION_GRACE_MS = Number(process.env.OPENCODE_NOTIFY_QQ_PERMISSION_GRACE_MS ?? 1500);

/**
 * De-duplicate pushes of the same kind within a short window.
 *
 * One finished turn can emit several signals in the same second (an ESC
 * interrupt produces a burst), so without this one end-of-turn becomes several
 * messages on the phone.
 *
 * The window is claimed through the filesystem rather than an in-memory map:
 * opencode loads a local plugin more than once, and the instances do not share
 * module state, so a counter would let each one push the same event.
 */
const DEDUP_MS = Number(process.env.OPENCODE_NOTIFY_QQ_DEDUP_MS ?? 5000);
const DEDUP_DIR = join(tmpdir(), "opencode-notify", "notify-qq");

function shouldSend(kind: string): boolean {
  const claim = join(DEDUP_DIR, kind);
  try {
    mkdirSync(DEDUP_DIR, { recursive: true });
    // An exclusive create succeeds for exactly one instance per window.
    mkdirSync(claim);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") {
      // Cannot claim at all: fail open, a notification matters more than noise.
      return true;
    }
    try {
      // A winner that never came back (crash) must not block the kind forever.
      if (Date.now() - statSync(claim).mtimeMs >= DEDUP_MS) {
        rmSync(claim, { recursive: true, force: true });
        return shouldSend(kind);
      }
    } catch {
      /* the claim vanished between the two calls */
    }
    trace(`dedup: suppressed duplicate ${kind} (within ${DEDUP_MS}ms)`);
    return false;
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
    /** Retry helper for delivery. */
    deliverWithRetry: typeof import("../src/deliver").deliverWithRetry;
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
      const deliver = await import(qqbotPath.replace("qqbot.ts", "deliver.ts"));
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
        deliverWithRetry: deliver.deliverWithRetry,
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

function bridgeStatePath(): string {
  return process.env.OPENCODE_NOTIFY_QQ_BRIDGE_STATE || join(HERE, "bridge.state.json");
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

/** V2 plugin entrypoint. Returns a cleanup that stops the event subscription. */
async function setup(ctx: Plugin.Context): Promise<() => void> {
  let api: Client | null = null;
  let loadError: string | null = null;
  try {
    api = await loadClient();
  } catch (cause) {
    loadError = cause instanceof Error ? cause.message : String(cause);
  }

  await ensureBridge();

  // `/bt <问题>`: the aside with tools, asked from the TUI. The bridge owns that
  // logic, so this only forwards the question; the bridge drops the answer back
  // into the session as a synthetic message when it is ready.
  const bridgePort = Number(process.env.OPENCODE_NOTIFY_QQ_LOCK_PORT ?? 4097);
  await ctx.command.transform((editor) => {
    editor.add({
      name: "bt",
      description: "旁问（带工具）：在一次性分支里跑一轮，答案回写到本会话",
      execute: async ({ sessionID, prompt }) => {
        try {
          const res = await fetch(`http://127.0.0.1:${bridgePort}/aside`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionID, question: prompt.text }),
          });
          const data = (await res.json()) as { ok?: boolean; error?: string };
          if (!data.ok) throw new Error(data.error ?? `bridge responded ${res.status}`);
        } catch (cause) {
          const why = cause instanceof Error ? cause.message : String(cause);
          await ctx.session
            .synthetic({
              sessionID,
              text: `**旁问**\n\n启动失败：${why}（bridge 没在 127.0.0.1:${bridgePort} 上？）`,
            })
            .catch(() => {});
        }
      },
    });
  });

  /**
   * Identify the session's workspace unambiguously.
   *
   * The directory comes from the event (or the session), never from this plugin
   * instance: opencode loads a local plugin once per location, so the instance's
   * own directory belongs to whichever location loaded it, not to the session
   * that fired the event.
   */
  function workspaceOf(event: NotifyEvent, fallback?: string): string {
    const dir = event.location?.directory ?? fallback ?? ctx.location.directory ?? process.cwd();
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const short = home && dir.toLowerCase().startsWith(home.toLowerCase()) ? `~${dir.slice(home.length)}` : dir;
    return short.replace(/\\/g, "/");
  }

  if (loadError) {
    console.error(`[notify-qq] ${loadError}`);
  } else {
    console.log("[notify-qq] notify_qq tool registered");
  }

  /** Send, retrying a transient failure so a notification is not silently lost. */
  async function trySend(text: string, markdown = false): Promise<string> {
    if (!api) {
      trace(`send skipped: api not loaded (${loadError})`);
      return `notify_qq unavailable: ${loadError}`;
    }
    const doSend = () => (markdown ? api!.sendMarkdown(text) : api!.sendText(text)).then(() => {});
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const outcome = await api.deliverWithRetry(doSend, sleep);

    if (outcome.ok) {
      trace(`sent: ${text}`);
      return "sent to QQ";
    }
    // Give up, but leave a durable trace: a lost remote notification is exactly
    // what this feature exists to prevent, so it must not vanish.
    trace(`send FAILED after ${outcome.attempts} attempts: ${outcome.error}`);
    try {
      appendFileSync(join(HERE, "notify-qq.undelivered.log"), `${new Date().toISOString()} ${text}\n`, "utf8");
    } catch {
      /* the log is best-effort; the failure is already traced */
    }
    return `failed to send after ${outcome.attempts} attempts: ${outcome.error}`;
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
   * `session.retry.scheduled` carries the attempt count. We only warn about a
   * *long* failing streak, and only once per streak, so the state is
   * {start, notified}; it clears when the turn ends.
   */
  const retryStreak = new Map<string, { start: number; notified: boolean }>();
  /** Warn once a streak has been failing this long. */
  const RETRY_NOTIFY_MS = Number(process.env.OPENCODE_NOTIFY_QQ_RETRY_MS ?? 60_000);

  function handleRetry(
    sessionID: string | undefined,
    attempt: number | undefined,
    message: string | undefined,
    workspace: string,
  ): void {
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

  type SessionInfo = { parentID?: string; title?: string; directory?: string; aside?: boolean };
  const sessionCache = new Map<string, SessionInfo>();

  /** Resolve whether a session is a subagent, and its title. */
  async function sessionInfo(sessionID: string): Promise<SessionInfo> {
    const cached = sessionCache.get(sessionID);
    if (cached) return cached;
    try {
      // V2 returns the session record directly, not a `{ data }` envelope.
      const data = await ctx.session.get({ sessionID });
      const info: SessionInfo = {
        parentID: data.parentID,
        title: data.title,
        directory: data.location?.directory,
        // A `.bt` aside is a fork with no parentID, so it is recognised by the
        // marker the bridge puts on it (the title is the fallback).
        aside:
          (data as { metadata?: { aside?: boolean } }).metadata?.aside === true ||
          Boolean(data.title?.startsWith("旁问 ·")),
      };
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
      const messages = await ctx.session.context({ sessionID });
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

  /** Handle one V2 event; V2 carries every payload under `data`. */
  async function handleEvent(event: NotifyEvent): Promise<void> {
    const type = event.type;

    // Bash watchdog: a long-running command is caught by a timer, so it only
    // needs arming and disarming. V2's `session.tool.called` carries no tool
    // name, so an input.command marks the call as a shell call.
    if (type === "session.tool.called") {
      const callID = event.data?.id;
      const cmd = event.data?.input?.command;
      if (callID && typeof cmd === "string" && bashWatch) {
        bashCommands.set(callID, cmd);
        bashWatch.observe({ callID, status: "running" });
      }
      return;
    }

    if (type === "session.tool.success" || type === "session.tool.failed") {
      const callID = event.data?.id;
      if (callID && bashWatch) {
        bashWatch.observe({ callID, status: type === "session.tool.success" ? "completed" : "error" });
        bashCommands.delete(callID);
      }
      return;
    }

    // A retry means the model call failed and is being re-attempted. A single
    // retry is normal and must not wake you; only a streak that keeps failing
    // long enough is worth a message. Notify once per streak.
    if (type === "session.retry.scheduled") {
      trace(`event:${type}`);
      handleRetry(event.data?.sessionID, event.data?.attempt, event.data?.error?.message, workspaceOf(event));
      return;
    }

    // V2 has no session.idle or session.status event on the public stream, so
    // the turn boundary is the step that ends without wanting a tool call:
    // `finish: "tool-calls"` means the turn continues.
    if (type === "session.step.ended") {
      if (event.data?.finish === "tool-calls") return;
      trace("event:session.step.ended (turn end)");
      await handleTurnEnd(event);
      return;
    }

    if (type !== "permission.asked") return;
    trace(`event:${type}`);

    // A permission request means the agent is BLOCKED and cannot proceed
    // without you. This is the most important "come back" signal, so it is
    // sent even though it is not "completion".
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
    // An auto-accepted request is answered within milliseconds; only a request
    // that is genuinely waiting for you deserves a message.
    if (!(await stillWaiting(event.data))) {
      trace("permission skipped: already resolved");
      return;
    }
    if (!shouldSend("permission")) {
      trace("permission skipped: dedup");
      return;
    }
    await trySend(`opencode · 需要授权 [${workspaceOf(event)}]`);
  }

  /**
   * True when a permission request is still unanswered after a short grace.
   *
   * Only auto-accept can resolve a request before a human sees it, so with
   * manual approval there is nothing to wait for. Fails open: a lookup error
   * counts as "still waiting", so a real notice is never lost.
   */
  async function stillWaiting(data: NotifyEvent["data"]): Promise<boolean> {
    const sessionID = data?.sessionID;
    const requestID = data?.id;
    if (!sessionID || !requestID) return true;
    if (!autoAcceptEnabled()) return true;
    await new Promise((r) => setTimeout(r, PERMISSION_GRACE_MS));
    try {
      const pending = await ctx.permission.list({ sessionID });
      return pending.some((p) => p.id === requestID);
    } catch {
      return true;
    }
  }

  /** The turn is over: report it, unless it was a subagent finishing. */
  async function handleTurnEnd(event: NotifyEvent): Promise<void> {
    const sessionID = event.data?.sessionID;
    // A turn that ends clears any retry streak for the session.
    if (sessionID) retryStreak.delete(sessionID);

    // Subagents finish while the main session keeps working; reporting them
    // as "done" is misleading and noisy. Off unless explicitly enabled.
    const info = sessionID ? await sessionInfo(sessionID) : {};
    // An aside fork answers a `.bt` the bridge is about to relay itself; a push
    // here would announce it as a finished session.
    if (info.aside) {
      trace(`turn end skipped: aside fork (${shortTitle(info.title)})`);
      return;
    }
    if (info.parentID) {
      if (process.env.OPENCODE_NOTIFY_SUBAGENT !== "1") {
        trace(`turn end skipped: subagent (${shortTitle(info.title)})`);
        return;
      }
      if (!awayEnabled()) return;
      if (!shouldSend("subagent")) return;
      await trySend(`opencode · 子代理完成 [${shortTitle(info.title)}]`);
      return;
    }

    // A command's result is a reply, not an unsolicited push: it goes out even
    // with the away switch off. Consuming the mark here is also what stops the
    // same turn from being reported twice when the switch is on.
    const viaCommand = sessionID ? takeCommandOutcome(sessionID) : false;
    if (!viaCommand && !awayEnabled()) {
      trace("turn end skipped: awayNotify is off");
      return;
    }
    if (!shouldSend("idle")) {
      trace("turn end skipped: dedup");
      return;
    }

    // Include a headline so the push says WHAT finished, not just "done".
    // Disable with OPENCODE_NOTIFY_QQ_SUMMARY=0 for the old bare message.
    const wantSummary = process.env.OPENCODE_NOTIFY_QQ_SUMMARY !== "0";
    const summary = wantSummary && sessionID ? headline(await lastAssistantText(sessionID)) : "";
    // Show the session number so a reply can name it (`.stop #2`). The number
    // is allocated by the bridge; if the bridge never saw this session yet,
    // omit rather than invent one.
    const num = sessionID ? api?.sessionNumber(sessionID) : undefined;
    const heading = num !== undefined ? `**opencode · 完成 · #${num}**` : `**opencode · 完成**`;
    const workspace = workspaceOf(event, info.directory);
    // Markdown so the heading and body render instead of collapsing into one
    // run-on line.
    const md = summary
      ? `${heading}\n\n\`${workspace}\`\n\n---\n\n${summary}`
      : `${heading}\n\n\`${workspace}\``;
    await trySend(md, true);
  }

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "notify_qq",
      description:
        "Send a short message to the user's QQ. Use when the user is away or explicitly asked " +
        "to be notified (long task finished, a decision is needed). Returns the send result.",
      input: {
        type: "object",
        properties: {
          message: { type: "string", description: "message text to send" },
        },
        required: ["message"],
        additionalProperties: false,
      },
      async execute(input) {
        const args = input as { message: string };
        return { content: await trySend(args.message) };
      },
    });

    editor.add({
      name: "qq_switch",
      description:
        "Read or change whether opencode pushes QQ while you are away " +
        "(turn finished or a permission is waiting). status=true reports; otherwise set enabled.",
      input: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "new state for away auto-push" },
          status: { type: "boolean", description: "report the current state instead of changing it" },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(input) {
        const args = input as { enabled?: boolean; status?: boolean };
        if (!api) return { content: `unavailable: ${loadError}` };
        try {
          if (args.status) {
            const cfg = api.loadConfig();
            const hasTarget = Boolean(cfg.qqbot?.notifyTarget);
            return {
              content: `away auto-push: ${cfg.awayNotify ? "ON" : "OFF"} | target configured: ${hasTarget ? "yes" : "no"} | config: ${api.configPath()}`,
            };
          }
          if (typeof args.enabled === "boolean") {
            const now = api.setAwayNotify(args.enabled);
            return { content: `away auto-push is now ${now ? "ON" : "OFF"} (takes effect immediately)` };
          }
          return { content: "nothing to do: pass status=true or enabled=<bool>" };
        } catch (cause) {
          return { content: `failed: ${cause instanceof Error ? cause.message : String(cause)}` };
        }
      },
    });
  });

  const controller = new AbortController();
  void (async () => {
    for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
      try {
        await handleEvent(raw as unknown as NotifyEvent);
      } catch (cause) {
        // One bad event must never kill the subscription.
        trace(`handler error: ${cause instanceof Error ? cause.message : cause}`);
      }
    }
  })();

  return () => controller.abort();
}

export default { id: "notify-qq", setup };
