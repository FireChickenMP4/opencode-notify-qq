/**
 * `/bt` — the side question that may use tools, asked from the TUI.
 *
 * The aside itself runs in the bridge (which owns the config, the fork, the
 * sandbox and the QQ copy), so this plugin only asks for it and shows the answer.
 * It asks with `wait=1`, which holds the HTTP request until the answer is ready,
 * and renders the result in a dialog — the TUI cannot render a `synthetic`
 * message, which is why the server-side command alone answered into the void.
 */
import { Plugin } from "@opencode/plugin/tui";

const TIMEOUT_MS = 20 * 60_000;
const BRIDGE = `http://127.0.0.1:${process.env.OPENCODE_NOTIFY_QQ_LOCK_PORT ?? 4097}`;

export default Plugin.define({
  id: "bt.tui",
  setup(context) {
    /** The session the user is looking at, if the router can say. */
    function currentSession(): string | undefined {
      const route = context.ui.router.current() as { type?: string; sessionID?: string } | undefined;
      return route?.type === "session" && route.sessionID ? route.sessionID : undefined;
    }

    async function ask(question: string): Promise<{ answer?: string; error?: string }> {
      try {
        const res = await fetch(`${BRIDGE}/aside?wait=1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: currentSession(), question }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const data = (await res.json()) as { answer?: string; error?: string; ok?: boolean };
        if (data.error) return { error: data.error };
        if (!data.ok && !data.answer) return { error: `bridge 返回 ${res.status}` };
        return { answer: data.answer };
      } catch (cause) {
        const why = cause instanceof Error ? cause.message : String(cause);
        return { error: `${why}（bridge 没在 127.0.0.1:${BRIDGE.split(":").pop()} 上？）` };
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "bt.ask",
          title: "旁问（带工具）",
          group: "notify-qq",
          bind: "<leader>p",
          palette: true,
          slash: { name: "bt", arguments: true },
          run: async (input) => {
            const question = (input ?? "").trim();
            if (!question) {
              await context.ui.dialog.alert({
                title: "旁问",
                message: "用法：`/bt <问题>`（也可用快捷键）。\n\n答案由一次性的旁问分支给出：它懂当前会话的上下文、能用只读工具，答完就把分支删掉。",
              });
              return;
            }
            const { answer, error } = await ask(question);
            await context.ui.dialog.alert({
              title: error ? "旁问失败" : answer ? "旁问答案" : "旁问（没有内容）",
              message: error ?? answer ?? "（这一轮没有产出文本，可能是超时或分支被收掉了）",
            });
          },
        },
      ],
      bindings: ["bt.ask"],
    }));
  },
});
