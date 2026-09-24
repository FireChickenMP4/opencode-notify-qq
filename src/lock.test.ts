/**
 * Single-instance lock: the bridge must refuse a second copy.
 *
 * The lock is a bound TCP port (not a PID file) so the OS releases it when the
 * process dies - no stale state to clean up.
 */

import { afterEach, describe, expect, test } from "bun:test";

let listeners: Array<ReturnType<typeof Bun.listen>> = [];

afterEach(() => {
  for (const l of listeners) l.stop(true);
  listeners = [];
});

function bind(port: number): boolean {
  try {
    listeners.push(Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }));
    return true;
  } catch {
    return false;
  }
}

describe("lock port", () => {
  test("first bind succeeds, second is refused", () => {
    const port = 45999;
    expect(bind(port)).toBe(true);
    expect(bind(port)).toBe(false);
  });

  test("releases after stop, allowing a re-bind", () => {
    const port = 45998;
    const l = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    l.stop(true);
    // Give the OS a moment to release.
    Bun.sleepSync(50);
    expect(bind(port)).toBe(true);
  });
});
