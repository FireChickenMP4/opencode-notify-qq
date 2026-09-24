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
 * works while the agent is busy (a `/qq-on` command would need an idle session,
 * which is exactly when you don't need it).
 *
 * Setup: credentials + switch in ~/.config/opencode/notify-qq.json (see README).
 */

import { tool, type Plugin } from "@opencode-ai/plugin";

type Client = {
  sendText: (m: string) => Promise<{ id?: string }>;
  configPath: () => string;
  loadConfig: () => { qqbot?: { notifyTarget?: unknown }; idleNotify: boolean };
  setIdleNotify: (enabled: boolean) => boolean;
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
        setIdleNotify: config.setIdleNotify,
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
  function idleEnabled(): boolean {
    if (!api) return false;
    try {
      return api.loadConfig().idleNotify === true;
    } catch {
      return false;
    }
  }

  return {
    config: async (config) => {
      config.command ??= {};
      config.command["qq-on"] ??= {
        description: "Enable QQ push when a turn finishes",
        template:
          "Call the qq_switch tool with enabled=true, then confirm the new state briefly. " +
          "If the call fails, tell the user to edit ~/.config/opencode/notify-qq.json directly.",
      };
      config.command["qq-off"] ??= {
        description: "Disable QQ push when a turn finishes",
        template:
          "Call the qq_switch tool with enabled=false, then confirm the new state briefly.",
      };
      config.command["qq-status"] ??= {
        description: "Show QQ notification status",
        template: "Call the qq_switch tool with status=true and report the result.",
      };
    },

    event: async ({ event }) => {
      // V2 signals "done" via session.status with status.type === "idle".
      if (event.type !== "session.status") return;
      const status = (event as { properties?: { status?: { type?: string } } }).properties?.status;
      if (status?.type !== "idle") return;
      if (!idleEnabled()) return;
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
          "Read or change whether opencode auto-pushes QQ when a turn finishes. " +
          "status=true reports; otherwise set enabled.",
        args: {
          enabled: tool.schema.boolean().optional().describe("new state for idle auto-push"),
          status: tool.schema.boolean().optional().describe("report the current state instead of changing it"),
        },
        async execute(args) {
          if (!api) return `unavailable: ${loadError}`;
          try {
            if (args.status) {
              const cfg = api.loadConfig();
              const hasTarget = Boolean(cfg.qqbot?.notifyTarget);
              return `idle auto-push: ${cfg.idleNotify ? "ON" : "OFF"} | target configured: ${hasTarget ? "yes" : "no"} | config: ${api.configPath()}`;
            }
            if (typeof args.enabled === "boolean") {
              const now = api.setIdleNotify(args.enabled);
              return `idle auto-push is now ${now ? "ON" : "OFF"} (takes effect immediately)`;
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
