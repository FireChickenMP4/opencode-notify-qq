/**
 * Reply parsing: the tolerant alias table.
 *
 * Users type these from a phone, so the parser must accept a leading dot,
 * mixed case, and Chinese words without ambiguity.
 */

import { describe, expect, test } from "bun:test";

import { parseReply } from "../src/bridge";

describe("parseReply", () => {
  test("single letters, both cases", () => {
    expect(parseReply("o")).toBe("once");
    expect(parseReply("O")).toBe("once");
    expect(parseReply("a")).toBe("always");
    expect(parseReply("A")).toBe("always");
    expect(parseReply("r")).toBe("reject");
    expect(parseReply("R")).toBe("reject");
  });

  test("leading dot (half and full width)", () => {
    expect(parseReply(".o")).toBe("once");
    expect(parseReply(".A")).toBe("always");
    expect(parseReply("．r")).toBe("reject");
  });

  test("words, both cases", () => {
    expect(parseReply("once")).toBe("once");
    expect(parseReply("Once")).toBe("once");
    expect(parseReply("ALWAYS")).toBe("always");
    expect(parseReply("Reject")).toBe("reject");
  });

  test("Chinese synonyms", () => {
    expect(parseReply("批准")).toBe("once");
    expect(parseReply("记住")).toBe("always");
    expect(parseReply("拒绝")).toBe("reject");
  });

  test("surrounding whitespace is ignored", () => {
    expect(parseReply("  .O  ")).toBe("once");
  });

  test("unknown text is undefined (so .task is not eaten)", () => {
    expect(parseReply(".task fix the bug")).toBeUndefined();
    expect(parseReply("hello")).toBeUndefined();
    expect(parseReply("")).toBeUndefined();
  });
});
