/**
 * QQ notification tool for opencode.
 *
 * Registers a `notify_qq` tool so the agent can push a message to the user's
 * QQ when they are away (long task finished, a decision is needed, the user
 * said they were stepping out). It is a TOOL, not an event hook: the agent
 * decides when a notification is warranted. See PLAN.md.
 *
 * Sending uses QQ's REST API, which is stateless - multiple opencode sessions
 * can call it concurrently without conflict. Receiving messages is different:
 * the WSS gateway tolerates only one connection per appId+shard, so a future
 * ".task" listener must be a single daemon (PLAN.md §4).
 *
 * Setup: credentials go in ~/.config/opencode/notify-qq.json (see README).
 */

import { tool, type Plugin } from "@opencode-ai/plugin";

// The client sources sit next to this file once installed as
// `plugins/notify-qq.ts` + `plugins/notify-qq/`. In the repo they live under
// `src/`, so try both and fail with an actionable message.
async function loadClient(): Promise<{
  sendText: (m: string) => Promise<{ id?: string }>;
  QqBotError: new (message: string, code?: number) => Error & { code?: number };
  configPath: () => string;
  loadConfig: () => { qqbot?: { notifyTarget?: unknown } };
}> {
  const candidates = ["./notify-qq/qqbot.ts", "../src/qqbot.ts"];
  for (const qqbotPath of candidates) {
    try {
      const qqbot = await import(qqbotPath);
      const config = await import(qqbotPath.replace("qqbot.ts", "config.ts"));
      return {
        sendText: qqbot.sendText,
        QqBotError: qqbot.QqBotError,
        configPath: config.configPath,
        loadConfig: config.loadConfig,
      };
    } catch {
      continue;
    }
  }
  throw new Error(
    "cannot locate notify-qq client sources. Re-run install.ps1 from the repo root.",
  );
}

export const NotifyQqPlugin: Plugin = async ({ client }) => {
  let api: Awaited<ReturnType<typeof loadClient>> | null = null;
  let loadError: string | null = null;
  try {
    api = await loadClient();
  } catch (cause) {
    loadError = cause instanceof Error ? cause.message : String(cause);
  }

  const configured = Boolean(api?.loadConfig().qqbot?.notifyTarget);

  await client.app
    .log({
      body: {
        service: "notify-qq",
        level: loadError ? "warn" : configured ? "info" : "warn",
        message:
          loadError ??
          (configured ? "notify_qq tool registered" : "notify_qq: no target configured"),
      },
    })
    .catch(() => {});

  return {
    tool: {
      notify_qq: tool({
        description:
          "Send a short message to the user's QQ. Use when the user is away or explicitly asked " +
          "to be notified (long task finished, a decision is needed). Returns the send result.",
        args: {
          message: tool.schema.string().describe("message text to send"),
        },
        async execute(args) {
          if (!api) return `notify_qq unavailable: ${loadError}`;
          try {
            const result = await api.sendText(args.message);
            return `sent to QQ (id=${result.id ?? "?"})`;
          } catch (cause) {
            const err = cause as { message?: string; code?: number };
            const code = typeof err?.code === "number" ? ` (code=${err.code})` : "";
            return `failed to send: ${err?.message ?? String(cause)}${code}`;
          }
        },
      }),
    },
  };
};
