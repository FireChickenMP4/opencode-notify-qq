/**
 * Marks the sessions whose turn was started by a remote command.
 *
 * The bridge writes the mark when it injects a `.task` / `.ask`, and the plugin
 * consumes it when that turn ends. While it is set, the plugin reports the
 * result even if the away switch is off: a command's outcome is a *reply*, not
 * an unsolicited push.
 *
 * Only the plugin sends, so the reply and the automatic push can never double
 * up. The mark lives in the temp dir because the two processes share it and
 * neither owns the other's lifetime.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A mark older than this is ignored: a turn that never ends must not mark forever. */
function ttlMs(): number {
  return Number(process.env.OPENCODE_NOTIFY_QQ_OUTCOME_TTL_MS ?? 6 * 60 * 60 * 1000);
}

function markerDir(): string {
  return process.env.OPENCODE_NOTIFY_QQ_OUTCOME_DIR || join(tmpdir(), "opencode-notify", "qq-command");
}

/** Session ids are ASCII, but keep the path safe whatever arrives. */
function markerPath(sessionID: string): string {
  return join(markerDir(), sessionID.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** Record that this session's next finished turn is a command's result. */
export function markCommandOutcome(sessionID: string): void {
  try {
    mkdirSync(markerDir(), { recursive: true });
    writeFileSync(markerPath(sessionID), String(Date.now()), "utf8");
  } catch {
    // Best effort: without the mark the away switch decides, which is the old behaviour.
  }
}

/** Consume the mark: true when this turn is a command's result (and it is fresh). */
export function takeCommandOutcome(sessionID: string): boolean {
  const path = markerPath(sessionID);
  try {
    const at = Number(readFileSync(path, "utf8").trim()) || 0;
    rmSync(path, { force: true });
    return Date.now() - at <= ttlMs();
  } catch {
    return false;
  }
}
