/**
 * Turn-final text selection.
 *
 * This was wrong three times: "last message with text" (grabbed a tool-step
 * preamble), "collect and truncate" (produced a 前略 marker), and not skipping
 * a trailing injected `.task` (returned "" right at idle). The rule is now "skip
 * pending trailing user turns, then the last text-only assistant message".
 */

import { describe, expect, test } from "bun:test";

import { pickFallbackText, pickFinalText } from "../plugins/notify-qq";

const A = (parts: Array<{ type: string; text?: string }>) => ({ info: { role: "assistant" }, parts });
const U = (text: string) => ({ info: { role: "user" }, parts: [{ type: "text", text }] });

describe("pickFinalText", () => {
  test("takes the last text-only assistant message", () => {
    const msgs = [
      U("do it"),
      A([{ type: "text", text: "let me check" }, { type: "tool" }]),
      A([{ type: "text", text: "here is the result" }]),
      A([{ type: "tool" }]), // trailing tool step, no text
    ];
    expect(pickFinalText(msgs)).toBe("here is the result");
  });

  test("skips a message that contains a tool part even if it has text", () => {
    const msgs = [
      U("go"),
      A([{ type: "text", text: "preamble before tool" }, { type: "tool" }]),
    ];
    expect(pickFinalText(msgs)).toBe("");
  });

  test("stops at the turn boundary (user message)", () => {
    const msgs = [
      A([{ type: "text", text: "OLD turn answer" }]),
      U("new turn"),
      A([{ type: "tool" }]),
    ];
    expect(pickFinalText(msgs)).toBe("");
  });

  test("ignores a trailing injected .task (idle race)", () => {
    // The bridge injects the queued task as a user message the moment the
    // session goes idle; the completion push must still show the prior reply.
    const msgs = [
      U("earlier work"),
      A([{ type: "text", text: "the previous turn's answer" }]),
      U(".task do the next thing"), // injected, not yet answered
    ];
    expect(pickFinalText(msgs)).toBe("the previous turn's answer");
  });

  test("ignores several trailing unreplied user messages", () => {
    const msgs = [
      U("old"),
      A([{ type: "text", text: "answer" }]),
      U("injected 1"),
      U("injected 2"),
    ];
    expect(pickFinalText(msgs)).toBe("answer");
  });

  test("joins multiple text parts of the chosen message", () => {
    const msgs = [U("x"), A([{ type: "text", text: "part1" }, { type: "text", text: "part2" }])];
    expect(pickFinalText(msgs)).toBe("part1\n\npart2");
  });

  test("empty input yields empty", () => {
    expect(pickFinalText([])).toBe("");
  });

  test("ignores blank-only text", () => {
    const msgs = [U("x"), A([{ type: "text", text: "   " }])];
    expect(pickFinalText(msgs)).toBe("");
  });

  test("all-user input yields empty", () => {
    expect(pickFinalText([U("a"), U("b")])).toBe("");
  });
});

describe("pickFallbackText", () => {
  test("returns the last text from a tool-step message", () => {
    const msgs = [
      U("go"),
      A([{ type: "text", text: "let me check the logs" }, { type: "tool" }]),
    ];
    expect(pickFallbackText(msgs)).toBe("let me check the logs");
  });

  test("takes the LAST text part, not the first", () => {
    const msgs = [
      U("go"),
      A([{ type: "text", text: "starting" }, { type: "text", text: "and now the real bit" }, { type: "tool" }]),
    ];
    expect(pickFallbackText(msgs)).toBe("and now the real bit");
  });

  test("prefers nothing over a tool-only step", () => {
    const msgs = [U("go"), A([{ type: "tool" }])];
    expect(pickFallbackText(msgs)).toBe("");
  });

  test("skips a trailing injected .task too", () => {
    const msgs = [
      U("earlier"),
      A([{ type: "text", text: "fragment before the tool" }, { type: "tool" }]),
      U(".task next"),
    ];
    expect(pickFallbackText(msgs)).toBe("fragment before the tool");
  });

  test("stops at the turn boundary", () => {
    const msgs = [
      A([{ type: "text", text: "old" }, { type: "tool" }]),
      U("new turn"),
      A([{ type: "tool" }]),
    ];
    expect(pickFallbackText(msgs)).toBe("");
  });
});
