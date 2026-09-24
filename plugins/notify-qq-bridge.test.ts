/**
 * Stale-bridge detection.
 *
 * The bridge is a detached daemon; the lock port makes startup idempotent, so
 * an old build would be reused forever and every bridge change needed a manual
 * kill. The daemon now records {pid, hash}; the plugin compares and replaces
 * when they differ. These tests lock that decision down.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bridgeHash, runningBridgeIsCurrent } from "../src/notify-helpers";

let dir: string | null = null;
function stateFile(content: string): string {
  dir = mkdtempSync(join(tmpdir(), "bridge-state-"));
  const p = join(dir, "bridge.state.json");
  writeFileSync(p, content, "utf8");
  return p;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("runningBridgeIsCurrent", () => {
  test("false when the recorded hash differs (rebuild)", async () => {
    const p = stateFile(JSON.stringify({ pid: process.pid, hash: "oldhash" }));
    expect(await runningBridgeIsCurrent(p, "newhash")).toBe(false);
  });

  test("true when hash matches and the pid is alive", async () => {
    const p = stateFile(JSON.stringify({ pid: process.pid, hash: "same" }));
    expect(await runningBridgeIsCurrent(p, "same")).toBe(true);
  });

  test("false when the pid is gone", async () => {
    const p = stateFile(JSON.stringify({ pid: 999_999_999, hash: "same" }));
    expect(await runningBridgeIsCurrent(p, "same")).toBe(false);
  });

  test("false when the state file is missing", async () => {
    expect(await runningBridgeIsCurrent(join(tmpdir(), "nope-xyz.json"), "same")).toBe(false);
  });

  test("unverifiable hash trusts the running bridge (no churn)", async () => {
    expect(await runningBridgeIsCurrent(join(tmpdir(), "nope-xyz.json"), "")).toBe(true);
  });
});

describe("bridgeHash", () => {
  test("stable for identical content, differs for different content", () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-hash-"));
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(a, "console.log(1)", "utf8");
    writeFileSync(b, "console.log(2)", "utf8");
    expect(bridgeHash(a)).toBe(bridgeHash(a));
    expect(bridgeHash(a)).not.toBe(bridgeHash(b));
  });

  test("empty string when the file is unreadable", () => {
    expect(bridgeHash(join(tmpdir(), "missing-file-xyz.ts"))).toBe("");
  });
});
