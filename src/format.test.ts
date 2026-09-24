/**
 * Permission notification formatting.
 *
 * The raw bash command is unreadable on a phone (one long line), and for
 * external_directory the command is not even the point - the DIRECTORY is, since
 * that is what "always" remembers. These tests pin the layout to the real
 * payloads measured from opencode.
 */

import { describe, expect, test } from "bun:test";

import { formatPermission } from "../src/bridge";

describe("formatPermission", () => {
  test("external_directory shows directories and always-scope, with fenced command", () => {
    const out = formatPermission(
      "D:/Desktop",
      "external_directory",
      {
        command: "ls C:\\Users\\1\\.config",
        directories: ["C:\\Users\\1\\.config"],
        patterns: ["C:\\Users\\1\\.config\\*"],
      },
      ["C:\\Users\\1\\.config\\*"],
    );
    expect(out).toContain("访问目录");
    expect(out).toContain("- `C:\\Users\\1\\.config`");
    expect(out).toContain("记住(always)范围");
    expect(out).toContain("- `C:\\Users\\1\\.config\\*`");
    expect(out).toContain("```sh");
  });

  test("bash puts the command in a fence", () => {
    const out = formatPermission("D:/Desktop", "bash", { command: "npm run build\n  --dir src" }, []);
    expect(out).toContain("```sh");
    expect(out).toContain("npm run build");
    expect(out).toContain("  --dir src");
  });

  test("edit falls back to filePath", () => {
    const out = formatPermission("D:/Desktop", "edit", { filePath: "src/a.ts" }, []);
    expect(out).toContain("src/a.ts");
  });

  test("falls back to patterns when nothing else exists", () => {
    const out = formatPermission("D:/Desktop", "webfetch", {}, ["https://*"]);
    expect(out).toContain("https://*");
  });

  test("always ends with the reply legend", () => {
    const out = formatPermission("D:/Desktop", "bash", { command: "x" }, []);
    expect(out).toContain(".o");
    expect(out).toContain(".a");
    expect(out).toContain(".r");
  });

  test("shows the session number in the header when known", () => {
    const out = formatPermission("D:/Desktop", "bash", { command: "x" }, [], 2);
    expect(out).toContain("#2");
  });

  test("omits the number when unknown", () => {
    const out = formatPermission("D:/Desktop", "bash", { command: "x" }, []);
    expect(out).not.toContain("#");
  });
});
