/**
 * Reply parsing: the tolerant alias table.
 *
 * Users type these from a phone, so the parser must accept a leading dot,
 * mixed case, and Chinese words without ambiguity. Command parsing is tested
 * here too since both read the same raw QQ text.
 */

import { describe, expect, test } from "bun:test";

import { parseCommand, parseReply, promptPath } from "../src/bridge";

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

  test("stop takes no body", () => {
    expect(parseCommand(".stop")).toEqual({ kind: "stop" });
  });

  test("restart is no longer a command", () => {
    expect(parseCommand(".restart")).toBeUndefined();
  });

  test("case-insensitive, full-width and Chinese dot", () => {
    expect(parseCommand(".TASK upper")).toEqual({ kind: "task", text: "upper" });
    expect(parseCommand("．stop")).toEqual({ kind: "stop" });
    expect(parseCommand("。stop")).toEqual({ kind: "stop" });
  });

  test("#N names a session on any command", () => {
    expect(parseCommand(".stop #2")).toEqual({ kind: "stop", target: 2 });
    expect(parseCommand(".task #1 deploy it")).toEqual({ kind: "task", text: "deploy it", target: 1 });
    expect(parseCommand(".ask #12 why")).toEqual({ kind: "ask", text: "why", target: 12 });
  });

  test("a body starting with a number is not a target", () => {
    expect(parseCommand(".task 2 things to do")).toEqual({ kind: "task", text: "2 things to do" });
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

describe("parseReply Chinese dot", () => {
  test("。a is accepted like .a", () => {
    expect(parseReply("。a")).toBe("always");
    expect(parseReply("。r")).toBe("reject");
  });
});

describe("promptPath", () => {
  test("uses prompt_async, not the no-op v2 admit route", () => {
    // The v2 `/api/session/{id}/prompt` accepts a prompt and returns an
    // admittedSeq but never delivers it. Regression guard.
    expect(promptPath("ses_abc")).toBe("/session/ses_abc/prompt_async");
    expect(promptPath("ses_abc")).not.toContain("/api/session/");
  });
});
