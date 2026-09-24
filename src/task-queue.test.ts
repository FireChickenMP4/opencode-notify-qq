/**
 * Per-session task queue.
 *
 * `.task` means "after this turn". Since opencode gives no real queue route,
 * the bridge holds messages here and releases one per idle. FIFO order and
 * per-session isolation are the guarantees that matter.
 */

import { describe, expect, test } from "bun:test";

import { TaskQueue } from "../src/task-queue";

describe("TaskQueue", () => {
  test("FIFO order", () => {
    const q = new TaskQueue();
    q.push("s1", "first");
    q.push("s1", "second");
    expect(q.peek("s1")).toBe("first");
    expect(q.shift("s1")).toBe("first");
    expect(q.shift("s1")).toBe("second");
    expect(q.shift("s1")).toBeUndefined();
  });

  test("sessions are independent", () => {
    const q = new TaskQueue();
    q.push("s1", "a");
    q.push("s2", "b");
    expect(q.size("s1")).toBe(1);
    expect(q.size("s2")).toBe(1);
    expect(q.shift("s1")).toBe("a");
    expect(q.size("s1")).toBe(0);
    expect(q.size("s2")).toBe(1);
  });

  test("push reports the new length", () => {
    const q = new TaskQueue();
    expect(q.push("s1", "x")).toBe(1);
    expect(q.push("s1", "y")).toBe(2);
  });

  test("peek does not remove", () => {
    const q = new TaskQueue();
    q.push("s1", "only");
    expect(q.peek("s1")).toBe("only");
    expect(q.size("s1")).toBe(1);
  });

  test("empty session is harmless", () => {
    const q = new TaskQueue();
    expect(q.peek("none")).toBeUndefined();
    expect(q.shift("none")).toBeUndefined();
    expect(q.size("none")).toBe(0);
  });

  test("drains one at a time (burst stays ordered)", () => {
    const q = new TaskQueue();
    q.push("s1", "1");
    q.push("s1", "2");
    q.push("s1", "3");
    expect(q.shift("s1")).toBe("1");
    expect(q.shift("s1")).toBe("2");
    expect(q.shift("s1")).toBe("3");
  });
});
