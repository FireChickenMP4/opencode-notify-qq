/**
 * Bash watchdog.
 *
 * A blocked command emits no further events, so "has it run too long" needs a
 * timer, not event counting. These tests drive a fake scheduler so the decision
 * logic is checked without real time.
 */

import { describe, expect, test } from "bun:test";

import { BashWatch, bashAlert, type Scheduler } from "../src/bash-watch";

/** A scheduler that records timers and lets tests fire them by hand. */
function fakeScheduler() {
  const timers = new Map<number, () => void>();
  let next = 1;
  const scheduler: Scheduler = {
    schedule(_ms, fn) {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    cancel(handle) {
      timers.delete(handle as number);
    },
  };
  return {
    scheduler,
    fireAll() {
      for (const fn of [...timers.values()]) fn();
      timers.clear();
    },
    size: () => timers.size,
  };
}

describe("BashWatch", () => {
  test("alerts when a running command passes the threshold", () => {
    const s = fakeScheduler();
    const alerts: string[] = [];
    const w = new BashWatch(90_000, s.scheduler, ({ callID }) => alerts.push(callID));

    w.observe({ callID: "c1", status: "running", startMs: 1000 });
    expect(s.size()).toBe(1);
    s.fireAll();
    expect(alerts).toEqual(["c1"]);
  });

  test("does not alert if the command completes first", () => {
    const s = fakeScheduler();
    const alerts: string[] = [];
    const w = new BashWatch(90_000, s.scheduler, ({ callID }) => alerts.push(callID));

    w.observe({ callID: "c1", status: "running", startMs: 1000 });
    w.observe({ callID: "c1", status: "completed" });
    expect(s.size()).toBe(0);
    s.fireAll();
    expect(alerts).toEqual([]);
  });

  test("arms only one timer per call, however many running events arrive", () => {
    const s = fakeScheduler();
    const w = new BashWatch(90_000, s.scheduler, () => {});
    w.observe({ callID: "c1", status: "running", startMs: 1000 });
    w.observe({ callID: "c1", status: "running", startMs: 1000 });
    w.observe({ callID: "c1", status: "running", startMs: 1000 });
    expect(s.size()).toBe(1);
  });

  test("alerts at most once per call", () => {
    const s = fakeScheduler();
    const alerts: string[] = [];
    const w = new BashWatch(90_000, s.scheduler, ({ callID }) => alerts.push(callID));
    w.observe({ callID: "c1", status: "running", startMs: 1000 });
    s.fireAll();
    s.fireAll(); // no more timers
    expect(alerts).toEqual(["c1"]);
  });

  test("tracks separate calls independently", () => {
    const s = fakeScheduler();
    const alerts: string[] = [];
    const w = new BashWatch(90_000, s.scheduler, ({ callID }) => alerts.push(callID));
    w.observe({ callID: "c1", status: "running", startMs: 1 });
    w.observe({ callID: "c2", status: "running", startMs: 2 });
    w.observe({ callID: "c2", status: "completed" });
    expect(s.size()).toBe(1); // only c1 left
    s.fireAll();
    expect(alerts).toEqual(["c1"]);
  });

  test("pending status does not arm", () => {
    const s = fakeScheduler();
    const w = new BashWatch(90_000, s.scheduler, () => {});
    w.observe({ callID: "c1", status: "pending" });
    expect(s.size()).toBe(0);
  });
});

describe("bashAlert", () => {
  test("includes elapsed seconds and the command", () => {
    const out = bashAlert("npm run build --watch", 95_000);
    expect(out).toContain("95s");
    expect(out).toContain("npm run build --watch");
    expect(out).toContain("```sh");
  });

  test("flattens and caps a long command", () => {
    const out = bashAlert("x".repeat(400), 120_000);
    expect(out).toContain("...");
    expect(out.length).toBeLessThan(400);
  });
});
