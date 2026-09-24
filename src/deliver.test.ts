/**
 * Delivery retry.
 *
 * A transient network blip once dropped a completion push silently. The send is
 * now retried before giving up; sleep is injected so this is instant to test.
 */

import { describe, expect, test } from "bun:test";

import { deliverWithRetry } from "../src/deliver";

const noSleep = async () => {};

describe("deliverWithRetry", () => {
  test("succeeds on the first attempt", async () => {
    let calls = 0;
    const out = await deliverWithRetry(async () => { calls++; }, noSleep);
    expect(out).toEqual({ ok: true, attempts: 1 });
    expect(calls).toBe(1);
  });

  test("retries a transient failure then succeeds", async () => {
    let calls = 0;
    const out = await deliverWithRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("typo in the url or port");
    }, noSleep);
    expect(out).toEqual({ ok: true, attempts: 3 });
    expect(calls).toBe(3);
  });

  test("gives up after the budget and reports the last error", async () => {
    let calls = 0;
    const out = await deliverWithRetry(async () => { calls++; throw new Error("down"); }, noSleep);
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(3); // 1 initial + 2 retries
    expect(out.error).toBe("down");
    expect(calls).toBe(3);
  });

  test("uses the supplied backoff schedule", async () => {
    const slept: number[] = [];
    await deliverWithRetry(
      async () => { throw new Error("x"); },
      async (ms) => { slept.push(ms); },
      [10, 20],
    );
    expect(slept).toEqual([10, 20]);
  });

  test("no retries when the schedule is empty", async () => {
    let calls = 0;
    const out = await deliverWithRetry(async () => { calls++; throw new Error("x"); }, noSleep, []);
    expect(out.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("non-Error throw is reported as a string", async () => {
    const out = await deliverWithRetry(async () => { throw "boom"; }, noSleep, []);
    expect(out.error).toBe("boom");
  });
});
