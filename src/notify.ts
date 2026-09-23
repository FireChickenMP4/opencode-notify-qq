/**
 * notify CLI: push a message to the configured QQ bot.
 *
 * Credentials come from the config layer; nothing is hardcoded.
 *
 * Usage:
 *   bun run prototype/notify.ts "消息内容"
 *   bun run prototype/notify.ts --check           # verify token + config
 *   bun run prototype/notify.ts --listen          # connect and print events
 */

import { loadConfig, configPath } from "./config";
import { QqBotClient, getAccessToken, QqBotError, sendText } from "./qqbot";

async function check(): Promise<number> {
  const path = configPath();
  const cfg = loadConfig();

  console.log(`config: ${path}`);

  if (!cfg.qqbot) {
    console.log("  qqbot: NOT configured");
    console.log(`\nAdd an "qqbot" section to ${path} (see README).`);
    return 2;
  }

  console.log(`  qqbot.appId: ${cfg.qqbot.appId.slice(0, 6)}...`);
  console.log(`  qqbot.clientSecret: ${cfg.qqbot.clientSecret ? "(set)" : "(missing)"}`);
  console.log(`  qqbot.notifyTarget: ${cfg.qqbot.notifyTarget ? JSON.stringify(cfg.qqbot.notifyTarget) : "(not set)"}`);

  try {
    const token = await getAccessToken(true);
    console.log(`  token: OK (${token.slice(0, 8)}...)`);
  } catch (cause) {
    console.log(`  token: FAILED - ${cause instanceof Error ? cause.message : cause}`);
    return 1;
  }
  return 0;
}

async function listen(): Promise<number> {
  console.log("connecting to QQ gateway (Ctrl+C to stop)...");
  const client = new QqBotClient({
    onLog: (m) => console.log(`[gateway] ${m}`),
    onEvent: (e) => {
      if (e.t) console.log(`[event] ${e.t} ${JSON.stringify(e.d).slice(0, 200)}`);
    },
  });
  await client.connect();
  // Keep the process alive; this is a foreground listener by design.
  await new Promise(() => {});
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args[0] === "--check") return check();
  if (args[0] === "--listen") return listen();

  const content = args.join(" ").trim();
  if (!content) {
    console.error('usage: notify.ts "message" | --check | --listen');
    return 2;
  }

  try {
    const result = await sendText(content);
    console.log(`sent (id=${result.id ?? "?"})`);
    return 0;
  } catch (cause) {
    if (cause instanceof QqBotError) {
      console.error(`QQ bot error: ${cause.message}${cause.code ? ` (code=${cause.code})` : ""}`);
      return 1;
    }
    console.error(`error: ${cause instanceof Error ? cause.message : cause}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
