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
        sendMarkdown: qqbot.sendMarkdown,
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
    const { existsSync, openSync } = await import("node:fs");
    const here = dirname(fileURLToPath(import.meta.url));
    // Installed layout: <plugins>/notify-qq/bridge.ts ; repo layout: <repo>/src/bridge.ts
    const candidates = [join(here, "notify-qq", "bridge.ts"), join(here, "..", "src", "bridge.ts")];
    const script = candidates.find((p) => existsSync(p));
    if (!script) {
      trace(`bridge not started: script not found (${candidates.join(", ")})`);
      return;
    }
    const logFd = openSync(BRIDGE_LOG, "a");
    const child = spawn("bun", ["run", script], {
      detached: true,
      // Log to a file, not /dev/null: when the bridge misbehaves (bad server
      // URL, gateway conflict) the only way to see why is this output.
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    child.unref();
    trace(`bridge spawned pid=${child.pid} (log: ${BRIDGE_LOG})`);
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

  /**
   * The assistant's output for the turn that just ended.
   *
   * "Last message containing text" is wrong: the final message is often a
   * tool-call step whose only text is a one-line preamble, so the push shows a
   * fragment. Instead collect every assistant text part since the last user
   * message - that set is exactly what the agent said this turn, including the
   * wrap-up after its tool calls.
   *
   * Reads the transcript rather than calling /summarize (another model turn,
   * slow and costly) since we only need what the agent already wrote.
   */
  async function lastAssistantText(sessionID: string): Promise<string> {
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      const messages = (res as { data?: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }> }).data;
      if (!Array.isArray(messages)) return "";

      const collected: string[] = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.info?.role === "user") break;
        if (m.info?.role !== "assistant") continue;
        for (const p of m.parts ?? []) {
          if (p.type === "text" && p.text?.trim()) collected.push(p.text.trim());
        }
      }
      collected.reverse();

      // Intermediate preambles ("I'll check X...") sit before the real answer;
      // the substance is usually in the later blocks. Keep the tail.
      return collected.join("\n\n").trim();
    } catch {
      return "";
    }
  }

  /**
   * Condense the turn's final assistant output for a push.
   *
   * We take the WHOLE last assistant message (that is what the agent ended the
   * turn with), not one paragraph of it - picking "the last paragraph" grabbed
   * trailing questions ("want me to...?"), and picking "the first" grabbed
   * headings. Markdown is preserved so QQ renders it; only runaway blank lines
   * are collapsed and the length is capped.
   */
  function headline(text: string): string {
    const body = text
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+$/gm, "")
      .trim();
    if (body.length < 4) return "";
    if (body.length <= 600) return body;
    // Too long: keep the TAIL, which holds the wrap-up (the head is usually
    // preambles like "I'll check..."), and mark that it was trimmed.
    return `...(前略)\n\n${body.slice(-597)}`;
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

      // Include a headline so the push says WHAT finished, not just "done".
      // Disable with OPENCODE_NOTIFY_QQ_SUMMARY=0 for the old bare message.
      const wantSummary = process.env.OPENCODE_NOTIFY_QQ_SUMMARY !== "0";
      const summary = wantSummary && props.sessionID ? headline(await lastAssistantText(props.sessionID)) : "";
      // Markdown so the heading and body render instead of collapsing into one
      // run-on line.
      const md = summary
        ? `**opencode · 完成**\n\n\`${workspace}\`\n\n---\n\n${summary}`
        : `**opencode · 完成**\n\n\`${workspace}\``;
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
