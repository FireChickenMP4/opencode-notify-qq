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

export const NotifyQqPlugin: Plugin = async ({ client, directory }) => {
  let api: Client | null = null;
  let loadError: string | null = null;
  try {
    api = await loadClient();
  } catch (cause) {
    loadError = cause instanceof Error ? cause.message : String(cause);
  }

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
    if (!api) return `notify_qq unavailable: ${loadError}`;
    try {
      const result = await api.sendText(text);
      return `sent to QQ (id=${result.id ?? "?"})`;
    } catch (cause) {
      const err = cause as { message?: string; code?: number };
      const code = typeof err?.code === "number" ? ` (code=${err.code})` : "";
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

  return {
    event: async ({ event }) => {
      const type = event.type;

      // A permission request means the agent is BLOCKED and cannot proceed
      // without you. This is the most important "come back" signal, so it is
      // sent even though it is not "completion".
      if (type === "permission.asked") {
        if (!awayEnabled()) return;
        if (!shouldSend("permission")) return;
        await trySend(`opencode · 需要授权 [${workspace}]`);
        return;
      }

      // V2 signals "done" via session.status with status.type === "idle".
      if (type !== "session.status") return;
      const status = (event as { properties?: { status?: { type?: string } } }).properties?.status;
      if (status?.type !== "idle") return;
      if (!awayEnabled()) return;
      if (!shouldSend("idle")) return;
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
