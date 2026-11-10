/**
 * Reply parsing: the tolerant alias table.
 *
 * Users type these from a phone, so the parser must accept a leading dot,
 * mixed case, and Chinese words without ambiguity. Command parsing is tested
 * here too since both read the same raw QQ text.
 */

import { describe, expect, test } from "bun:test";

import { asideFraming, asideRules, asideVisibleInList, buildAnswerPayload, isRequestNotFoundError, truncateForQq, fmtAgo, fmtDuration, formatForm, formatList, formatStatus, isAsideSession, lastAssistantText, liveRequestIds, parseCommand, parseReply, questionOf, renderTranscript, replyTarget, turnEnded } from "../src/bridge";
import { bashAlertKey } from "../src/notify-helpers";

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

  test("a trailing #N is stripped, so `.a #2` still reads as always", () => {
    expect(parseReply(".a #2")).toBe("always");
    expect(parseReply("o #3")).toBe("once");
    expect(parseReply(".r#7")).toBe("reject");
  });
});

describe("replyTarget", () => {
  test("reads the optional session number, and nothing else", () => {
    expect(replyTarget(".a #2")).toBe(2);
    expect(replyTarget("r # 12")).toBe(12);
    expect(replyTarget(".o")).toBeUndefined();
    expect(replyTarget("hello")).toBeUndefined();
  });
});

describe("parseCommand", () => {
  test("task, ask and btw carry their body", () => {
    expect(parseCommand(".task fix the bug")).toEqual({ kind: "task", text: "fix the bug" });
    expect(parseCommand(".ask what about x")).toEqual({ kind: "ask", text: "what about x" });
    expect(parseCommand(".btw why did it fail")).toEqual({ kind: "btw", text: "why did it fail" });
    expect(parseCommand(".answer 生产")).toEqual({ kind: "answer", text: "生产" });
  });

  test("stop and list take no body", () => {
    expect(parseCommand(".stop")).toEqual({ kind: "stop" });
    expect(parseCommand(".list")).toEqual({ kind: "list" });
    expect(parseCommand(".LIST")).toEqual({ kind: "list" });
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
    expect(buildAnswerPayload(fields, "开发")).toEqual({ answer: "dev" });
    expect(buildAnswerPayload(fields, "prod")).toEqual({ answer: "prod" });
    expect(buildAnswerPayload(fields, " 生产 ")).toEqual({ answer: "prod" });
  });

  test("free text is sent as-is", () => {
    expect(buildAnswerPayload(fields, "先别动")).toEqual({ answer: "先别动" });
  });

  test("a field without a key is not answerable", () => {
    expect(buildAnswerPayload([{ title: "no key" }], "x")).toBeNull();
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

  test("an idle marker that is not the last message does not end it", () => {
    // The shape of a turn that paused for an approval and then carried on.
    expect(turnEnded([idle(), tool()])).toBe(false);
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

describe("asideFraming", () => {
  test("the opening follows the channel", () => {
    expect(asideFraming("bt", "", undefined, "guarded", "tui")).toContain("就坐在电脑前");
    expect(asideFraming("bt", "", undefined, "guarded", "qq")).toContain("不在电脑前");
    expect(asideFraming("bt", "")).toContain("不在电脑前");
  });

  test("both kinds say it is a phone-bound aside", () => {
    expect(asideFraming("btw", "")).toContain("QQ 旁问");
    expect(asideFraming("bt", "")).toContain("QQ 旁问");
  });

  test("each kind states its own capability boundary", () => {
    expect(asideFraming("btw", "")).toContain("没有工具可用");
    expect(asideFraming("bt", "")).toContain("用完即弃的临时分支");
  });

  test("the bt wording follows the mode: guarded forbids work outside the sandbox", () => {
    expect(asideFraming("bt", "", undefined, "guarded")).toContain("改不了工作区里的文件");
    expect(asideFraming("bt", "", undefined, "guarded")).toContain("沙盒");
    expect(asideFraming("bt", "", undefined, "full")).toContain("不会弹审批");
    expect(asideFraming("bt", "", undefined, "readonly")).toContain("只读");
  });

  test("the user's own words are appended last", () => {
    const out = asideFraming("bt", "回答用中文，先给结论");
    expect(out.trimEnd().endsWith("回答用中文，先给结论")).toBe(true);
  });

  test("no extra text leaves no dangling blank line", () => {
    expect(asideFraming("btw", "").endsWith("\n")).toBe(false);
  });

  test("the bt side names its sandbox", () => {
    expect(asideFraming("bt", "", "C:\\Temp\\aside\\ses_x")).toContain("C:\\Temp\\aside\\ses_x");
  });
});

describe("asideRules", () => {
  const sandbox = "C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\aside\\ses_x";
  const find = (mode: "readonly" | "guarded" | "full", action: string, resource: string) =>
    asideRules(mode, sandbox).find((r) => r.action === action && r.resource === resource)?.effect;

  test("readonly stops at reading", () => {
    expect(find("readonly", "read", "*")).toBe("allow");
    expect(find("readonly", "edit", "*")).toBe("deny");
    expect(find("readonly", "shell", "*")).toBe("deny");
  });

  test("guarded denies outside the sandbox, allows inside it", () => {
    expect(find("guarded", "edit", "*")).toBe("deny");
    expect(find("guarded", "shell", "*")).toBe("deny");
    expect(find("guarded", "read", "*")).toBe("allow");
    // The sandbox rule is listed last, so it wins for paths under it.
    expect(find("guarded", "edit", "C:/Users/me/AppData/Local/Temp/opencode/aside/ses_x/*")).toBe("allow");
  });

  test("full adds no rules of its own", () => {
    expect(asideRules("full", sandbox)).toHaveLength(0);
  });
});

describe("asideVisibleInList", () => {
  const now = 1_000_000_000;
  test("a running branch is always visible", () => {
    expect(asideVisibleInList({ time: { updated: now - 86_400_000 } }, now, true)).toBe(true);
  });

  test("a recent branch is visible, an old one is not", () => {
    expect(asideVisibleInList({ time: { updated: now - 60_000 } }, now, false)).toBe(true);
    expect(asideVisibleInList({ time: { updated: now - 20 * 60_000 } }, now, false)).toBe(false);
  });

  test("an unknown timestamp is treated as old", () => {
    expect(asideVisibleInList({}, now, false)).toBe(false);
  });
});

describe("liveRequestIds", () => {
  test("reads a bare array (what this endpoint really returns)", () => {
    expect([...liveRequestIds([{ id: "a" }, { id: "b" }])]).toEqual(["a", "b"]);
  });

  test("also reads an envelope, for endpoints that use one", () => {
    expect([...liveRequestIds({ data: [{ id: "c" }] })]).toEqual(["c"]);
  });

  test("empty and garbage give nothing", () => {
    expect(liveRequestIds([]).size).toBe(0);
    expect(liveRequestIds(null).size).toBe(0);
    expect(liveRequestIds({ nope: 1 }).size).toBe(0);
    expect(liveRequestIds([{ noId: true }, "x"]).size).toBe(0);
  });
});

describe("formatList", () => {
  test("title first, then state and directory", () => {
    const out = formatList([
      { num: 1, directory: "D:\\Desktop", state: "运行中", title: "插件迁移升级 → v2 适配" },
      { num: 2, directory: "D:\\Desktop", state: "空闲（12m 前）", title: "View patch" },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("**opencode · 会话列表**（最近 2）");
    expect(lines[1]).toBe("#1 插件迁移升级 → v2 适配 · 运行中 · `D:\\Desktop`");
    expect(lines[2]).toBe("#2 View patch · 空闲（12m 前） · `D:\\Desktop`");
  });

  test("a session without a title falls back to its directory", () => {
    expect(formatList([{ num: 3, directory: "E:\\repo", state: "空闲" }]).split("\n")[1]).toBe(
      "#3 E:\\repo · 空闲 · `E:\\repo`",
    );
  });

  test("caps the rows and says how many there are", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ num: i + 1, directory: "d", state: "空闲" }));
    const out = formatList(rows, 2).split("\n");
    expect(out[0]).toBe("**opencode · 会话列表**（最近 2 / 共 5）");
    expect(out).toHaveLength(3);
  });

  test("says so when there is nothing to list", () => {
    expect(formatList([])).toContain("还没有见过会话");
  });
});


/** A `question` tool field: q0/q1..., multiselect when asked with `multiple`. */
const questionField = (
  key: string,
  type = "multiselect",
  options?: Array<{ value: string; label: string }>,
) => ({ key, type, ...(options ? { options } : {}) });

test("a multiselect field takes a one-element string array", () => {
  expect(buildAnswerPayload([questionField("q0")], "生产环境")).toEqual({
    q0: ["生产环境"],
  });
});

test("an option matches by label or value and sends the form's value", () => {
  const options = [
    { value: "prod", label: "生产" },
    { value: "dev", label: "开发" },
  ];
  const fields = [questionField("q0", "multiselect", options)];
  expect(buildAnswerPayload(fields, "生产")).toEqual({ q0: ["prod"] });
  expect(buildAnswerPayload(fields, "PROD")).toEqual({ q0: ["prod"] });
});

test("only the first field is answered when the form asks several questions", () => {
  const fields = [questionField("q0"), questionField("q1")];
  expect(buildAnswerPayload(fields, "yes")).toEqual({ q0: ["yes"] });
});

test("fields are filled left to right, separated by |", () => {
  const fields = [questionField("q0", "string"), questionField("q1", "string")];
  expect(buildAnswerPayload(fields, "生产 | 明天")).toEqual({ q0: "生产", q1: "明天" });
});

test("a missing later answer is left out, so the server rejects and the form can be retried", () => {
  const fields = [questionField("q0", "string"), questionField("q1", "string")];
  expect(buildAnswerPayload(fields, "生产")).toEqual({ q0: "生产" });
});

test("a multi-field form lists every field and the pipe-separated hint", () => {
  const fields = [
    questionField("q0", "multiselect", [{ value: "prod", label: "生产" }]),
    { key: "q1", type: "string", title: "时间" },
  ];
  const text = formatForm("D:\\work", "选环境", fields, 2);
  expect(text).toContain("字段 2：时间");
  expect(text).toContain(".answer 答案1 | 答案2");
});

test("a plain string field keeps a bare string", () => {
  expect(buildAnswerPayload([questionField("q0", "string")], "自由文本")).toEqual({
    q0: "自由文本",
  });
});

test("empty or whitespace-only text is not an answer", () => {
  expect(buildAnswerPayload([questionField("q0")], "")).toBeNull();
  expect(buildAnswerPayload([questionField("q0")], "   \n")).toBeNull();
});

test("a form with no answerable field yields null", () => {
  expect(buildAnswerPayload([{ title: "no key" }], "x")).toBeNull();
});

test(".new takes the whole rest of the line as its first message", () => {
  expect(parseCommand(".new 帮我看下 xxx")).toEqual({
    kind: "new",
    text: "帮我看下 xxx",
    target: undefined,
  });
});

test(".new without body is still a command, so the caller can show usage", () => {
  expect(parseCommand(".new")).toEqual({ kind: "new", text: "", target: undefined });
  expect(parseCommand(".new   ")).toEqual({ kind: "new", text: "", target: undefined });
});

test(".new keeps a leading #N as message text, because it has no target", () => {
  expect(parseCommand(".new #3 看一下这个")).toEqual({
    kind: "new",
    text: "#3 看一下这个",
    target: undefined,
  });
});

test(".news is not .new", () => {
  expect(parseCommand(".news")).toBeUndefined();
  expect(parseCommand(".news 帮我看下")).toBeUndefined();
});

test("existing commands still parse", () => {
  expect(parseCommand(".task 做 x")).toEqual({ kind: "task", text: "做 x", target: undefined });
  expect(parseCommand(".ask 先看 y")).toEqual({ kind: "ask", text: "先看 y", target: undefined });
  expect(parseCommand(".btw 是什么")).toEqual({ kind: "btw", text: "是什么", target: undefined });
  expect(parseCommand(".bt 查一下")).toEqual({ kind: "bt", text: "查一下", target: undefined });
  expect(parseCommand(".answer 生产")).toEqual({ kind: "answer", text: "生产", target: undefined });
  expect(parseCommand(".stop")).toEqual({ kind: "stop", target: undefined });
  expect(parseCommand(".status")).toEqual({ kind: "status", target: undefined });
  expect(parseCommand(".list")).toEqual({ kind: "list", target: undefined });
  expect(parseCommand(".task #2 deploy")).toEqual({ kind: "task", text: "deploy", target: 2 });
});

test(".b backgrounds the target session, optionally by number", () => {
  expect(parseCommand(".b")).toEqual({ kind: "b", target: undefined });
  expect(parseCommand(".b #2")).toEqual({ kind: "b", target: 2 });
});

test(".bg and .background are not .b", () => {
  expect(parseCommand(".bg")).toBeUndefined();
  expect(parseCommand(".background")).toBeUndefined();
});

test(".git targets the current session, optionally by number", () => {
  expect(parseCommand(".git")).toEqual({ kind: "git", target: undefined });
  expect(parseCommand(".git #3")).toEqual({ kind: "git", target: 3 });
});

test(".gits and .gita are not .git", () => {
  expect(parseCommand(".gits")).toBeUndefined();
  expect(parseCommand(".gita 状态")).toBeUndefined();
});

test("a long reply is truncated within the limit and says so", () => {
  expect(truncateForQq("short", 100)).toBe("short");

  const cut = truncateForQq("x".repeat(500), 100);
  expect(cut.length).toBeLessThanOrEqual(100);
  expect(cut.endsWith("（已截断）")).toBe(true);
});

test("the bash alert dedup key is stable and filename-safe", () => {
  expect(bashAlertKey("call_abc")).toBe("bash-call_abc");
  expect(bashAlertKey("call_abc")).toBe(bashAlertKey("call_abc"));
  expect(bashAlertKey("a:b/c")).toBe("bash-a_b_c");
  expect(bashAlertKey("a:b/c")).not.toContain(":");
});

test("a not-found reply is recognised in every error shape", () => {
  expect(isRequestNotFoundError(new Error("Permission request not found: per_1"))).toBe(true);
  expect(isRequestNotFoundError({ message: "permission request NOT found: per_1" })).toBe(true);
  expect(isRequestNotFoundError("Permission request not found")).toBe(true);
});

test("other errors are not treated as a vanished request", () => {
  expect(isRequestNotFoundError(new Error("fetch failed"))).toBe(false);
  expect(isRequestNotFoundError({ message: "Permission denied" })).toBe(false);
  expect(isRequestNotFoundError("Request not found")).toBe(false);
  expect(isRequestNotFoundError({})).toBe(false);
  expect(isRequestNotFoundError(undefined)).toBe(false);
});
