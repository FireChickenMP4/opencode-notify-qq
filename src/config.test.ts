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

import { loadConfig, setIdleNotify } from "../src/config";

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

describe("idleNotify parsing", () => {
  test("defaults to OFF when absent", () => {
    expect(loadConfig(temp(JSON.stringify(creds))).idleNotify).toBe(false);
  });

  test("accepts a bare boolean", () => {
    expect(loadConfig(temp(JSON.stringify({ ...creds, idleNotify: true }))).idleNotify).toBe(true);
  });

  test("accepts { enabled: boolean }", () => {
    expect(loadConfig(temp(JSON.stringify({ ...creds, idleNotify: { enabled: true } }))).idleNotify).toBe(true);
  });

  test("a non-boolean enabled falls back to OFF", () => {
    expect(loadConfig(temp(JSON.stringify({ ...creds, idleNotify: { enabled: "yes" } }))).idleNotify).toBe(false);
  });
});

describe("setIdleNotify", () => {
  test("round-trips true and false", () => {
    const p = temp(JSON.stringify(creds));
    setIdleNotify(true, p);
    expect(loadConfig(p).idleNotify).toBe(true);
    setIdleNotify(false, p);
    expect(loadConfig(p).idleNotify).toBe(false);
  });

  test("preserves credentials and unknown keys", () => {
    const p = temp(JSON.stringify({ ...creds, somethingElse: 42 }));
    setIdleNotify(true, p);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.qqbot.appId).toBe("102000");
    expect(after.somethingElse).toBe(42);
  });
});
