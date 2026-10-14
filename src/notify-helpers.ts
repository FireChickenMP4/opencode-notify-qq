/**
 * Pure helpers used by the notify-qq plugin.
 *
 * These live OUTSIDE plugins/ on purpose, so the plugin file keeps a single
 * default export; the plugin imports them from a sibling module (repo `../src`,
 * installed `./notify-qq/`).
 */

import { readFileSync } from "node:fs";

/** Content hash of the bridge entry so a rebuilt daemon can be detected. */
export function bridgeHash(script: string): string {
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(readFileSync(script));
    return hasher.digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

/** True when the recorded bridge pid is alive and was built from `hash`. */
export function runningBridgeIsCurrent(statePath: string, hash: string): boolean {
  if (!hash) return true; // cannot verify; assume fine rather than churn processes
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { pid?: number; hash?: string };
    if (state.hash !== hash) return false;
    if (!state.pid) return false;
    process.kill(state.pid, 0); // throws if the pid is gone
    return true;
  } catch {
    return false;
  }
}

/**
 * The message shapes the pickers read. V2 tags each message with `type` and
 * keeps assistant output in `content`; every other message kind is ignored.
 */
export type SessionMessage = {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
};

export type MessageList = readonly SessionMessage[];

/**
 * Pick the turn's closing text from a message list.
 *
 * Rule: the LAST assistant message that has text and no tool part. A message
 * that calls a tool is not a conclusion, so it is skipped. Trailing messages
 * that are not assistant replies are skipped first - an injected remote task,
 * or a V2 turn-end marker - so the race push still shows the prior reply.
 */
export function pickFinalText(messages: MessageList): string {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.type !== "assistant") start--;

  for (let i = start; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === "user") break;
    if (m.type !== "assistant") continue;
    const parts = m.content ?? [];
    if (parts.some((p) => p.type === "tool")) continue;
    const text = parts
      .filter((p) => p.type === "text" && p.text?.trim())
      .map((p) => p.text!.trim())
      .join("\n\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * The most recent thing the agent actually said, even from a tool step.
 *
 * Used when pickFinalText finds no clean conclusion: an interrupted turn ends on
 * a tool message and has no text-only message, so the push would otherwise show
 * no body.
 */
export function pickFallbackText(messages: MessageList): string {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.type !== "assistant") start--;

  for (let i = start; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === "user") break;
    if (m.type !== "assistant") continue;
    const texts = (m.content ?? []).filter((p) => p.type === "text" && p.text?.trim());
    const last = texts[texts.length - 1];
    if (last?.text?.trim()) return last.text.trim();
  }
  return "";
}

/**
 * Tidy the turn's closing text for a push.
 *
 * The input is already the final text-only message, so it is complete and must
 * NOT be trimmed to a headline: an earlier 800-char cap silently cut the tail
 * off ordinary replies. QQ markdown accepts far more (verified >12k chars), so
 * `maxChars` is only a runaway guard.
 */
export function normalizeFinalText(text: string, maxChars: number): string {
  const body = text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  if (body.length < 4) return "";
  return body.length > maxChars ? `${body.slice(0, Math.max(0, maxChars - 3))}...` : body;
}
