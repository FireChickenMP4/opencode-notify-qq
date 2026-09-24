/**
 * Stable session numbers.
 *
 * A session id is too long to type from a phone, so each is mapped to a small
 * integer that a reply can name (`.stop #2`). Numbers must be stable: the same
 * id always yields the same number, and numbers are never reused.
 */

import { describe, expect, test } from "bun:test";

import { SessionNumbers } from "../src/sessions";

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

  test("entries are ascending and complete", () => {
    const s = new SessionNumbers();
    s.numberFor("ses_a");
    s.numberFor("ses_b");
    expect(s.entries()).toEqual([[1, "ses_a"], [2, "ses_b"]]);
  });
});
