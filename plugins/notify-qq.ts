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
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

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
  configPath: () => string;
  loadConfig: () => { qqbot?: { notifyTarget?: unknown }; awayNotify: boolean };
  setAwayNotify: (enabled: boolean) => boolean;
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
      return {
        sendText: qqbot.sendText,
        configPath: config.configPath,
        loadConfig: config.loadConfig,
        setAwayNotify: config.setAwayNotify,
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
 * Make sure the bridge daemon is running.
 *
 * Idempotent by construction: the bridge binds a lock port, so starting a
 * second one simply exits. Here we probe the port first and only spawn when
 * nothing is listening - so opening N opencode instances still yields exactly
 * one bridge.
 *
 * The bridge is spawned detached: it must outlive the opencode process, since
 * its job is to keep serving approvals while you are away. Nothing stops it on
 * plugin dispose, on purpose (another opencode may still be running).
 */
async function ensureBridge(): Promise<void> {
  if (process.env.OPENCODE_NOTIFY_QQ_BRIDGE === "0") return;
  const port = Number(process.env.OPENCODE_NOTIFY_QQ_LOCK_PORT ?? 4097);

  if (await isPortOpen(port)) {
    trace(`bridge already running (port ${port})`);
    return;
  }

  try {
    const { spawn } = await import("node:child_process");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { existsSync } = await import("node:fs");
    const here = dirname(fileURLToPath(import.meta.url));
    // Installed layout: <plugins>/notify-qq/bridge.ts ; repo layout: <repo>/src/bridge.ts
    const candidates = [join(here, "notify-qq", "bridge.ts"), join(here, "..", "src", "bridge.ts")];
    const script = candidates.find((p) => existsSync(p));
    if (!script) {
      trace(`bridge not started: script not found (${candidates.join(", ")})`);
      return;
    }
    const child = spawn("bun", ["run", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    trace(`bridge spawned pid=${child.pid}`);
  } catch (cause) {
    trace(`bridge spawn failed: ${cause instanceof Error ? cause.message : cause}`);
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
  async function trySend(text: string): Promise<string> {
    if (!api) {
      trace(`send skipped: api not loaded (${loadError})`);
      return `notify_qq unavailable: ${loadError}`;
    }
    try {
      const result = await api.sendText(text);
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

  return {
    event: async ({ event }) => {
      const type = event.type;
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
        if (!shouldSend("permission")) {
          trace("permission skipped: dedup");
          return;
        }
        await trySend(`opencode · 需要授权 [${workspace}]`);
        return;
      }

      // V2 signals "done" via session.status with status.type === "idle".
      const props = (event as { properties?: { sessionID?: string; status?: { type?: string } } }).properties;
      if (props?.status?.type !== "idle") return;

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
      await trySend(`opencode · 完成 [${workspace}]`);
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
