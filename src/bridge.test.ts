/**
 * Reply parsing: the tolerant alias table.
 *
 * Users type these from a phone, so the parser must accept a leading dot,
 * mixed case, and Chinese words without ambiguity. Command parsing is tested
 * here too since both read the same raw QQ text.
 */

import { describe, expect, test } from "bun:test";

import { parseCommand, parseReply } from "../src/bridge";

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

describe("parseCommand", () => {
  test("task and ask carry their body", () => {
    expect(parseCommand(".task fix the bug")).toEqual({ kind: "task", text: "fix the bug" });
    expect(parseCommand(".ask what about x")).toEqual({ kind: "ask", text: "what about x" });
  });

  test("stop and restart take no body", () => {
    expect(parseCommand(".stop")).toEqual({ kind: "stop" });
    expect(parseCommand(".restart")).toEqual({ kind: "restart" });
  });

  test("case-insensitive, full-width dot", () => {
    expect(parseCommand(".TASK upper")).toEqual({ kind: "task", text: "upper" });
    expect(parseCommand("．stop")).toEqual({ kind: "stop" });
  });

  test("a bare .task with no body is not a command", () => {
    expect(parseCommand(".task")).toBeUndefined();
    expect(parseCommand(".ask   ")).toBeUndefined();
  });

  test("does not swallow o/a/r or chatter", () => {
    expect(parseCommand("o")).toBeUndefined();
    expect(parseCommand("hello")).toBeUndefined();
    expect(parseCommand(".taskx no")).toBeUndefined();
  });
});
