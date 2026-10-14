/**
 * Reply parsing: the tolerant alias table.
 *
 * Users type these from a phone, so the parser must accept a leading dot,
 * mixed case, and Chinese words without ambiguity. Command parsing is tested
 * here too since both read the same raw QQ text.
 */

import { describe, expect, test } from "bun:test";

import { buildAnswer, fmtAgo, fmtDuration, formatForm, formatStatus, isAsideSession, lastAssistantText, parseCommand, parseReply, questionOf, renderTranscript, turnEnded } from "../src/bridge";

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
  test("task, ask and btw carry their body", () => {
    expect(parseCommand(".task fix the bug")).toEqual({ kind: "task", text: "fix the bug" });
    expect(parseCommand(".ask what about x")).toEqual({ kind: "ask", text: "what about x" });
    expect(parseCommand(".btw why did it fail")).toEqual({ kind: "btw", text: "why did it fail" });
    expect(parseCommand(".answer 生产")).toEqual({ kind: "answer", text: "生产" });
  });

  test("stop takes no body", () => {
    expect(parseCommand(".stop")).toEqual({ kind: "stop" });
  });

  test("bt is the tool-using side question, btw stays the plain one", () => {
    expect(parseCommand(".bt read the log and say why it failed")).toEqual({
      kind: "bt",
      text: "read the log and say why it failed",
    });
    expect(parseCommand(".btw why did it fail")).toEqual({ kind: "btw", text: "why did it fail" });
    expect(parseCommand(".bt #2 check the build")).toEqual({ kind: "bt", text: "check the build", target: 2 });
    expect(parseCommand(".bt")).toBeUndefined();
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

  test("a bare .task or .btw with no body is not a command", () => {
    expect(parseCommand(".task")).toBeUndefined();
    expect(parseCommand(".ask   ")).toBeUndefined();
    expect(parseCommand(".btw")).toBeUndefined();
  });

  test("does not swallow o/a/r or chatter", () => {
    expect(parseCommand("o")).toBeUndefined();
    expect(parseCommand("hello")).toBeUndefined();
    expect(parseCommand(".taskx no")).toBeUndefined();
    expect(parseCommand(".btwx no")).toBeUndefined();
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
      { type: "user", text: "hi there" },
      {
        type: "assistant",
        content: [
          { type: "reasoning", text: "let me think" },
          { type: "text", text: "here is the answer" },
          {
            type: "tool",
            name: "edit",
            state: { status: "completed", input: { filePath: "app/x.go" } },
            time: { created: 1, completed: 2 },
          },
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
        type: "assistant",
        content: [
          { type: "tool", name: "bash", state: { status: "running", input: { command: "sleep 999" } }, time: { created: start } },
        ],
      },
    ]);
    expect(out[0]).toContain("bash [运行中");
    expect(out[0]).toContain("可能卡住");
    expect(out[0]).toContain("sleep 999");
  });

  test("keeps only the last maxLines transcript lines", () => {
    const content = Array.from({ length: 5 }, (_, i) => ({
      type: "tool",
      name: "bash",
      state: { status: "completed", input: { command: `c${i}` } },
    }));
    const out = renderTranscript([{ type: "assistant", content }], 3);
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

describe("form replies", () => {
  const fields = [
    {
      key: "answer",
      type: "string",
      title: "部署到哪个环境？",
      options: [
        { value: "prod", label: "生产" },
        { value: "dev", label: "开发" },
      ],
    },
  ];

  test("an option label or value maps to the option value", () => {
    expect(buildAnswer(fields, "开发")).toEqual({ answer: "dev" });
    expect(buildAnswer(fields, "prod")).toEqual({ answer: "prod" });
    expect(buildAnswer(fields, " 生产 ")).toEqual({ answer: "prod" });
  });

  test("free text is sent as-is", () => {
    expect(buildAnswer(fields, "先别动")).toEqual({ answer: "先别动" });
  });

  test("a field without a key is not answerable", () => {
    expect(buildAnswer([{ title: "no key" }], "x")).toBeNull();
  });

  test("the question push lists the options and the reply hint", () => {
    const out = formatForm("D:/Desktop", "部署到哪个环境？", fields, 3);
    expect(out).toContain("**需要你回答 · #3**");
    expect(out).toContain("部署到哪个环境？");
    expect(out).toContain("- 生产");
    expect(out).toContain(".answer");
  });

  test("questionOf prefers the first titled field, then the form title", () => {
    expect(questionOf({ title: "form", fields })).toBe("部署到哪个环境？");
    expect(questionOf({ title: "form", fields: [] })).toBe("form");
    expect(questionOf(undefined)).toBe("(无标题问题)");
  });
});

describe("parseReply Chinese dot", () => {
  test("。a is accepted like .a", () => {
    expect(parseReply("。a")).toBe("always");
    expect(parseReply("。r")).toBe("reject");
  });
});

describe("lastAssistantText", () => {
  test("takes the last text of the forked turn", () => {
    const msgs = [
      { type: "user", text: "question" },
      { type: "assistant", content: [{ type: "text", text: "inherited from the parent" }] },
      { type: "assistant", content: [{ type: "text", text: "from the parent, later" }] },
      { type: "assistant", content: [{ type: "tool", name: "read" }] },
      { type: "assistant", content: [{ type: "text", text: "the answer" }] },
    ];
    expect(lastAssistantText(msgs, 2)).toBe("the answer");
  });

  test("never falls back to what the parent said", () => {
    const msgs = [
      { type: "assistant", content: [{ type: "text", text: "the parent's own words" }] },
      { type: "assistant", content: [{ type: "tool", name: "read" }] },
    ];
    expect(lastAssistantText(msgs, 1)).toBe("");
  });
});

describe("turnEnded", () => {
  const A = (finish?: string, completed = true) => ({ type: "assistant", finish, time: completed ? { completed: 1 } : {} });
  const tool = () => ({ type: "assistant", finish: "tool-calls", time: { completed: 1 } });
  const idle = () => ({ type: "idle" });

  test("an idle marker ends the turn", () => {
    expect(turnEnded([A("stop"), idle()])).toBe(true);
  });

  test("a terminal finish ends it before the marker is written", () => {
    expect(turnEnded([tool(), A("stop")])).toBe(true);
  });

  test("a tool round is not the end", () => {
    expect(turnEnded([tool()])).toBe(false);
  });

  test("nothing happened yet", () => {
    expect(turnEnded([])).toBe(false);
    expect(turnEnded([idle()])).toBe(false);
  });
});

describe("isAsideSession", () => {
  test("marked by the bridge, or titled", () => {
    expect(isAsideSession({ metadata: { aside: true } })).toBe(true);
    expect(isAsideSession({ title: "旁问 · 为什么构建挂了" })).toBe(true);
  });

  test("an ordinary session is not an aside", () => {
    expect(isAsideSession({ title: "插件迁移升级 → v2 适配" })).toBe(false);
    expect(isAsideSession({})).toBe(false);
  });
});
