/**
 * `/bt` — the side question that may use tools, asked from the TUI.
 *
 * The aside itself runs in the bridge (which owns the config, the fork, the
 * sandbox and the QQ copy), so this plugin only asks for it and then shows where
 * the answer is. It asks with `wait=1` (the request is held until the answer is
 * ready), toasts right away so the wait is visible, and navigates to the kept
 * branch — a real session view renders markdown and scrolls, which a plugin dialog
 * cannot, and a `synthetic` transcript message is never displayed.
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

    async function ask(
      question: string,
      onSent?: (message: string) => void,
    ): Promise<{ answer?: string; error?: string; forkID?: string; branch?: number }> {
      try {
        onSent?.(`「${question.slice(0, 40)}」正在一次性分支里跑，约 30–120 秒；跑完会跳到那个分支。`);
        const res = await fetch(`${BRIDGE}/aside?wait=1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: currentSession(), question }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const data = (await res.json()) as {
          answer?: string;
          error?: string;
          ok?: boolean;
          forkID?: string;
          branch?: number;
        };
        if (data.error) return { error: data.error };
        if (!data.ok && !data.answer) return { error: `bridge 返回 ${res.status}` };
        return { answer: data.answer, forkID: data.forkID, branch: data.branch };
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
                message:
                  "用法：`/bt <问题>`（也可用快捷键）。\n\n答案由一次性的旁问分支给出：它懂当前会话的上下文、能用只读工具；跑完会把你跳到那个分支，读完可以 `.stop` 或在下次 `/bt` 时自动替换。",
              });
              return;
            }
            const { answer, error, forkID, branch } = await ask(question, (sent) => {
              // The run takes tens of seconds: without this the command looks like
              // it did nothing at all.
              context.ui.toast.show({
                title: "旁问已发出",
                message: sent,
                variant: "info",
                duration: 6000,
              });
            });
            if (error || !forkID) {
              await context.ui.dialog.alert({ title: "旁问失败", message: error ?? "bridge 没有返回分支" });
              return;
            }
            // The branch itself is the answer view: navigating there gives a real
            // session transcript, so markdown renders and long answers scroll. The
            // toast stays behind as a way back to it.
            context.ui.router.navigate({ type: "session", sessionID: forkID });
            context.ui.toast.show({
              title: branch !== undefined ? `旁问答案 · 分支 #${branch}` : "旁问答案",
              message: answer ? answer.slice(0, 140) : "（这一轮没有产出文本）",
              variant: answer ? "success" : "warning",
              sessionID: forkID,
            });
          },
        },
      ],
      bindings: ["bt.ask"],
    }));
  },
});
