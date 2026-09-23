/**
 * Connect to the QQ gateway for a bounded time and print incoming events.
 *
 * Bounded on purpose: a foreground gateway connection with no exit would hang
 * any caller. Default 60s, override with an argument.
 *
 * Usage:
 *   bun run prototype/qqbot-listen.ts [seconds]
 */

import { QqBotClient } from "./qqbot";

const seconds = Number(process.argv[2] ?? 60);
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error("usage: qqbot-listen.ts [seconds]");
  process.exit(2);
}

const client = new QqBotClient({
  onLog: (m) => console.log(`[gateway] ${m}`),
  onEvent: (e) => {
    if (!e.t) return;
    // C2C_MESSAGE_CREATE carries the sender's openid, which is what we need
    // for notifyTarget. Print the useful bits, not the whole payload.
    const d = e.d as { author?: { user_openid?: string }; content?: string; id?: string } | undefined;
    if (e.t === "C2C_MESSAGE_CREATE" && d?.author?.user_openid) {
      console.log(`[OPENID] user_openid = ${d.author.user_openid}`);
      console.log(`[MESSAGE] ${d.content ?? ""}`);
    } else if (e.t === "GROUP_AT_MESSAGE_CREATE") {
      const g = e.d as { group_openid?: string; author?: { member_openid?: string } };
      console.log(`[GROUP] group_openid = ${g.group_openid} member_openid = ${g.author?.member_openid}`);
    } else {
      console.log(`[event] ${e.t} ${JSON.stringify(e.d).slice(0, 160)}`);
    }
  },
  autoReconnect: false,
});

console.log(`listening for ${seconds}s; send the bot a private message now...`);
try {
  await client.connect();
} catch (cause) {
  console.error(`connect failed: ${cause instanceof Error ? cause.message : cause}`);
  process.exit(1);
}

// Bounded wait, then exit cleanly.
await new Promise((r) => setTimeout(r, seconds * 1000));
client.close();
console.log("listener stopped");
process.exit(0);
