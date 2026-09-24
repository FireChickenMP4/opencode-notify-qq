/**
 * Completion-text normalization.
 *
 * The push must carry the WHOLE closing message. An 800-char "headline" cap cut
 * the tail off ordinary replies, so the cap is now a high runaway guard only.
 */

import { describe, expect, test } from "bun:test";

import { normalizeFinalText } from "../plugins/notify-qq";

describe("normalizeFinalText", () => {
  test("keeps a long reply intact under the cap", () => {
    const text = "x".repeat(3000);
    expect(normalizeFinalText(text, 4000)).toBe(text);
  });

  test("does not append an ellipsis when under the cap", () => {
    expect(normalizeFinalText("hello world", 4000)).toBe("hello world");
  });

  test("truncates only beyond the cap, with a trailing ellipsis", () => {
    const out = normalizeFinalText("a".repeat(5000), 4000);
    expect(out.length).toBe(4000);
    expect(out.endsWith("...")).toBe(true);
  });

  test("collapses 3+ blank lines", () => {
    expect(normalizeFinalText("a\n\n\n\nb", 4000)).toBe("a\n\nb");
  });

  test("strips trailing spaces per line", () => {
    expect(normalizeFinalText("ab   \ncd\t", 4000)).toBe("ab\ncd");
  });

  test("too-short input yields empty", () => {
    expect(normalizeFinalText(" hi ", 4000)).toBe("");
  });
});
