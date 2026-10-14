/**
 * Command-outcome marks.
 *
 * The bridge sets a mark when it injects a remote command; the plugin consumes it
 * when that turn ends, so the result is delivered as a reply (independent of the
 * away switch) instead of an unsolicited push.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markCommandOutcome, takeCommandOutcome } from "../src/command-outcome";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qq-outcome-"));
  process.env.OPENCODE_NOTIFY_QQ_OUTCOME_DIR = dir;
});

afterEach(() => {
  delete process.env.OPENCODE_NOTIFY_QQ_OUTCOME_DIR;
  delete process.env.OPENCODE_NOTIFY_QQ_OUTCOME_TTL_MS;
  rmSync(dir, { recursive: true, force: true });
});

describe("command outcome marks", () => {
  test("no mark means it is not a command outcome", () => {
    expect(takeCommandOutcome("ses_a")).toBe(false);
  });

  test("a mark is consumed exactly once", () => {
    markCommandOutcome("ses_a");
    expect(takeCommandOutcome("ses_a")).toBe(true);
    expect(takeCommandOutcome("ses_a")).toBe(false);
  });

  test("marks are per session", () => {
    markCommandOutcome("ses_a");
    expect(takeCommandOutcome("ses_b")).toBe(false);
    expect(takeCommandOutcome("ses_a")).toBe(true);
  });

  test("a stale mark is ignored (and cleared)", async () => {
    process.env.OPENCODE_NOTIFY_QQ_OUTCOME_TTL_MS = "1";
    markCommandOutcome("ses_a");
    await new Promise((r) => setTimeout(r, 20));
    expect(takeCommandOutcome("ses_a")).toBe(false);
    expect(takeCommandOutcome("ses_a")).toBe(false);
  });

  test("an odd session id cannot escape the marker directory", () => {
    markCommandOutcome("../../evil");
    expect(takeCommandOutcome("../../evil")).toBe(true);
    expect(takeCommandOutcome("evil")).toBe(false);
  });
});
