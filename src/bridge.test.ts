/**
 * Reply parsing: the tolerant alias table.
 *
 * Users type these from a phone, so the parser must accept a leading dot,
 * mixed case, and Chinese words without ambiguity. Command parsing is tested
 * here too since both read the same raw QQ text.
 */

import { describe, expect, test } from "bun:test";

import { fmtAgo, fmtDuration, formatStatus, parseCommand, parseReply, promptPath, renderTranscript } from "../src/bridge";

describe("parseReply", () => {
  test("single letters, both cases", () => {
    expect(parseReply("o")).toBe("once");
    expect(parseReply("O")).toBe("once");
    expect(parseReply("a")).toBe("always");
    expect(parseReply("A")).toBe("always");
    expect(parseReply("r")).toBe("reject");
    expect(parseReply("R")).toBe("reject");
  });

  test("leading dot (half and full width)", () => {
    expect(parseReply(".o")).toBe("once");
    expect(parseReply(".A")).toBe("always");
    expect(parseReply("．r")).toBe("reject");
  });

  test("words, both cases", () => {
    expect(parseReply("once")).toBe("once");
    expect(parseReply("Once")).toBe("once");
    expect(parseReply("ALWAYS")).toBe("always");
    expect(parseReply("Reject")).toBe("reject");
  });

  test("Chinese synonyms", () => {
    expect(parseReply("批准")).toBe("once");
    expect(parseReply("记住")).toBe("always");
    expect(parseReply("拒绝")).toBe("reject");
  });

  test("surrounding whitespace is ignored", () => {
    expect(parseReply("  .O  ")).toBe("once");
  });

  test("unknown text is undefined (so .task is not eaten)", () => {
    expect(parseReply(".task fix the bug")).toBeUndefined();
    expect(parseReply("hello")).toBeUndefined();
    expect(parseReply("")).toBeUndefined();
  });
});

describe("parseCommand", () => {
  test("task and ask carry their body", () => {
    expect(parseCommand(".task fix the bug")).toEqual({ kind: "task", text: "fix the bug" });
    expect(parseCommand(".ask what about x")).toEqual({ kind: "ask", text: "what about x" });
  });

  test("stop takes no body", () => {
    expect(parseCommand(".stop")).toEqual({ kind: "stop" });
  });

  test("status takes no body, any dot or case", () => {
    expect(parseCommand(".status")).toEqual({ kind: "status" });
    expect(parseCommand(".STATUS")).toEqual({ kind: "status" });
    expect(parseCommand("．status")).toEqual({ kind: "status" });
    expect(parseCommand("。status")).toEqual({ kind: "status" });
  });

  test("status accepts an optional #N target", () => {
    expect(parseCommand(".status #2")).toEqual({ kind: "status", target: 2 });
  });

  test("restart is no longer a command", () => {
    expect(parseCommand(".restart")).toBeUndefined();
  });

  test("case-insensitive, full-width and Chinese dot", () => {
    expect(parseCommand(".TASK upper")).toEqual({ kind: "task", text: "upper" });
    expect(parseCommand("．stop")).toEqual({ kind: "stop" });
    expect(parseCommand("。stop")).toEqual({ kind: "stop" });
  });

  test("#N names a session on any command", () => {
    expect(parseCommand(".stop #2")).toEqual({ kind: "stop", target: 2 });
    expect(parseCommand(".task #1 deploy it")).toEqual({ kind: "task", text: "deploy it", target: 1 });
    expect(parseCommand(".ask #12 why")).toEqual({ kind: "ask", text: "why", target: 12 });
  });

  test("a body starting with a number is not a target", () => {
    expect(parseCommand(".task 2 things to do")).toEqual({ kind: "task", text: "2 things to do" });
  });

  test("a bare .task with no body is not a command", () => {
    expect(parseCommand(".task")).toBeUndefined();
    expect(parseCommand(".ask   ")).toBeUndefined();
  });

  test("does not swallow o/a/r or chatter", () => {
    expect(parseCommand("o")).toBeUndefined();
    expect(parseCommand("hello")).toBeUndefined();
    expect(parseCommand(".taskx no")).toBeUndefined();
    expect(parseCommand(".statusx")).toBeUndefined();
  });
});

describe("status formatting", () => {
  test("duration and age render compactly", () => {
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(192_000)).toBe("3m12s");
    expect(fmtDuration(3_720_000)).toBe("1h02m");
    expect(fmtAgo(null)).toBe("无");
    expect(fmtAgo(12_000)).toBe("12s 前");
  });

  test("transcript labels reasoning, output and tools, skips user text", () => {
    const out = renderTranscript([
      { info: { role: "user" }, parts: [{ type: "text", text: "hi there" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "let me think" },
          { type: "text", text: "here is the answer" },
          { type: "tool", tool: "edit", state: { status: "completed", title: "app/x.go" } },
        ],
      },
    ]);
    expect(out).toEqual([
      "思考> let me think",
      "输出> here is the answer",
      "工具> edit [完成] app/x.go",
    ]);
  });

  test("a running tool carries its elapsed time and the stuck flag", () => {
    const start = Date.now() - 120_000;
    const out = renderTranscript([
      {
        info: { role: "assistant" },
        parts: [{ type: "tool", tool: "bash", state: { status: "running", input: { command: "sleep 999" }, time: { start } } }],
      },
    ]);
    expect(out[0]).toContain("bash [运行中");
    expect(out[0]).toContain("可能卡住");
    expect(out[0]).toContain("sleep 999");
  });

  test("keeps only the last maxLines transcript lines", () => {
    const parts = Array.from({ length: 5 }, (_, i) => ({
      type: "tool",
      tool: "bash",
      state: { status: "completed", title: `c${i}` },
    }));
    const out = renderTranscript([{ info: { role: "assistant" }, parts }], 3);
    expect(out).toEqual(["工具> bash [完成] c2", "工具> bash [完成] c3", "工具> bash [完成] c4"]);
  });

  test("header line plus transcript tail", () => {
    const out = formatStatus({
      session: "#1 E:\\repo",
      gateway: true,
      pending: 0,
      busy: true,
      turnMs: 192_000,
      eventAgeMs: 5_000,
      transcript: ["思考> a", "工具> bash [运行中] x"],
      lines: 15,
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("会话 #1 E:\\repo · 运行中 3m12s | 事件 5s 前 | 待审批 0 | 网关 connected");
    expect(lines[1]).toBe("思考> a");
    expect(lines[2]).toBe("工具> bash [运行中] x");
  });

  test("idle header shows last activity", () => {
    const out = formatStatus({
      session: "#1 E:\\repo",
      gateway: false,
      pending: 2,
      busy: false,
      lastActivityMs: 240_000,
      eventAgeMs: 240_000,
      transcript: [],
    });
    expect(out).toBe("会话 #1 E:\\repo · 空闲（最后活动 4m00s 前） | 事件 4m00s 前 | 待审批 2 | 网关 disconnected");
  });
});

describe("parseReply Chinese dot", () => {
  test("。a is accepted like .a", () => {
    expect(parseReply("。a")).toBe("always");
    expect(parseReply("。r")).toBe("reject");
  });
});

describe("promptPath", () => {
  test("uses prompt_async, not the no-op v2 admit route", () => {
    // The v2 `/api/session/{id}/prompt` accepts a prompt and returns an
    // admittedSeq but never delivers it. Regression guard.
    expect(promptPath("ses_abc")).toBe("/session/ses_abc/prompt_async");
    expect(promptPath("ses_abc")).not.toContain("/api/session/");
  });
});
