/**
 * Turn-final text selection.
 *
 * This was wrong twice: first "last message with text" (grabbed a tool-step
 * preamble), then "collect and truncate" (produced a 前略 marker). The rule is
 * now "last assistant message with text and NO tool part", locked here.
 */

import { describe, expect, test } from "bun:test";

import { pickFinalText } from "../plugins/notify-qq";

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
});
