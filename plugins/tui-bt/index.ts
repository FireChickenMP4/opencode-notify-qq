/**
 * Server entrypoint of the bt plugin.
 *
 * The aside itself runs in the bridge (see `tui.ts`), so nothing is registered
 * here. It exists because a discovered plugin uses the published-package layout,
 * with the server and TUI entrypoints side by side.
 */
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "bt.tui.server",
  setup() {},
});
