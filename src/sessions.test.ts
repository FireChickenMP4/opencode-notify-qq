/**
 * Stable session numbers.
 *
 * A session id is too long to type from a phone, so each is mapped to a small
 * integer that a reply can name (`.stop #2`). Numbers must be stable: the same
 * id always yields the same number, and numbers are never reused.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionNumbers, readSessionNumbers } from "../src/sessions";

describe("SessionNumbers", () => {
  test("assigns 1, 2, 3 in first-seen order", () => {
    const s = new SessionNumbers();
    expect(s.numberFor("ses_a")).toBe(1);
    expect(s.numberFor("ses_b")).toBe(2);
    expect(s.numberFor("ses_c")).toBe(3);
  });

  test("the same id always returns the same number", () => {
    const s = new SessionNumbers();
    expect(s.numberFor("ses_a")).toBe(1);
    expect(s.numberFor("ses_b")).toBe(2);
    expect(s.numberFor("ses_a")).toBe(1);
  });

  test("resolves a number back to its id", () => {
    const s = new SessionNumbers();
    s.numberFor("ses_a");
    s.numberFor("ses_b");
    expect(s.resolve(1)).toBe("ses_a");
    expect(s.resolve(2)).toBe("ses_b");
    expect(s.resolve(99)).toBeUndefined();
  });

  test("lookup never allocates", () => {
    const s = new SessionNumbers();
    expect(s.lookup("ses_a")).toBeUndefined();
    s.numberFor("ses_a");
    expect(s.lookup("ses_a")).toBe(1);
    expect(s.resolve(2)).toBeUndefined(); // lookup did not create #2
  });

  test("entries are ascending and complete", () => {
    const s = new SessionNumbers();
    s.numberFor("ses_a");
    s.numberFor("ses_b");
    expect(s.entries()).toEqual([[1, "ses_a"], [2, "ses_b"]]);
  });

  test("persists across instances (survives restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessnum-"));
    const path = join(dir, "session-numbers.json");
    try {
      const first = new SessionNumbers(path);
      expect(first.numberFor("ses_a")).toBe(1);
      expect(first.numberFor("ses_b")).toBe(2);

      const second = new SessionNumbers(path);
      expect(second.lookup("ses_a")).toBe(1);
      expect(second.lookup("ses_b")).toBe(2);
      // A new session continues from max+1, not from scratch.
      expect(second.numberFor("ses_c")).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readSessionNumbers is read-only and tolerates a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessnum-"));
    const path = join(dir, "session-numbers.json");
    try {
      const ro = readSessionNumbers(path);
      expect(ro.lookup("ses_a")).toBeUndefined();
      expect(readFileSync).toBeDefined(); // file was never created by a read
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
