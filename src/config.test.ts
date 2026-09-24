/**
 * Config layer: credential parsing and the idle-notify switch.
 *
 * The switch is the user-facing control ("ping me when done"), so its parsing
 * and round-trip must be predictable, including the two accepted shapes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, setAwayNotify } from "../src/config";

const dirs: string[] = [];
function temp(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "qqcfg-"));
  dirs.push(dir);
  const p = join(dir, "notify-qq.json");
  if (content !== undefined) writeFileSync(p, content, "utf8");
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const creds = {
  qqbot: {
    appId: "102000",
    clientSecret: "s3cret",
    notifyTarget: { type: "c2c", openid: "u1" },
  },
};

describe("awayNotify parsing", () => {
  test("defaults to OFF when absent", () => {
    expect(loadConfig(temp(JSON.stringify(creds))).awayNotify).toBe(false);
  });

  test("accepts a bare boolean", () => {
    expect(loadConfig(temp(JSON.stringify({ ...creds, awayNotify: true }))).awayNotify).toBe(true);
  });

  test("accepts { enabled: boolean }", () => {
    expect(loadConfig(temp(JSON.stringify({ ...creds, awayNotify: { enabled: true } }))).awayNotify).toBe(true);
  });

  test("a non-boolean enabled falls back to OFF", () => {
    expect(loadConfig(temp(JSON.stringify({ ...creds, awayNotify: { enabled: "yes" } }))).awayNotify).toBe(false);
  });
});

describe("setAwayNotify", () => {
  test("round-trips true and false", () => {
    const p = temp(JSON.stringify(creds));
    setAwayNotify(true, p);
    expect(loadConfig(p).awayNotify).toBe(true);
    setAwayNotify(false, p);
    expect(loadConfig(p).awayNotify).toBe(false);
  });

  test("preserves credentials and unknown keys", () => {
    const p = temp(JSON.stringify({ ...creds, somethingElse: 42 }));
    setAwayNotify(true, p);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.qqbot.appId).toBe("102000");
    expect(after.somethingElse).toBe(42);
  });
});
