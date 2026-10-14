/**
 * bridge: single-process daemon for remote permission approval over QQ.
 *
 * It holds the one and only QQ gateway (WSS) connection, subscribes to the
 * opencode service's event stream, pushes pending permission requests to QQ, and
 * maps a one-letter QQ reply back to the permission reply API.
 *
 * The service is found the same way the CLI finds it: it registers itself (url +
 * password) and `Service.discover()` reads that registration, so no fixed port
 * and no manual `opencode serve` + attach is involved.
 *
 * Only one process may hold the WSS connection: a second Identify on the same
 * shard triggers `op 9 Invalid Session` and kicks the older one (see PLAN.md
 * §4.4). Run exactly one bridge.
 *
 * Usage:
 *   bun run src/bridge.ts            # start the daemon
 *   bun run src/bridge.ts --check    # verify config + token + service, then exit
 *   bun run src/bridge.ts --help
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client/promise";
import { headers, Service } from "@opencode/client/service";
import { markCommandOutcome } from "./command-outcome";
import { configPath, loadConfig } from "./config";
import { QqBotClient, getAccessToken, sendMarkdown, sendText, type GatewayEvent } from "./qqbot";
import { SessionNumbers, sessionNumbersPath } from "./sessions";
import { TaskQueue } from "./task-queue";

type OcClient = ReturnType<typeof OpenCode.make>;

/**
 * The opencode client, pointed at whichever local service is running.
 *
 * V2 has no fixed port: the service registers itself (url + password), and
 * `Service.discover()` reads that registration. It is re-resolved on every
 * reconnect, because a restarted service comes back on a different port.
 */
let oc: OcClient | null = null;

async function connectClient(): Promise<OcClient> {
  const endpoint = await Service.discover();
  if (!endpoint) {
    throw new Error("no local opencode service found (start opencode, or `opencode service restart`)");
  }
  oc = OpenCode.make({ baseUrl: endpoint.url, headers: headers(endpoint) });
  return oc;
}

/** The current client; every caller runs after `connectClient`. */
function client(): OcClient {
  if (!oc) throw new Error("opencode client not connected");
  return oc;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * TCP port used purely as a single-instance lock. Not a service; any connection
 * attempt is ignored. Chosen to sit next to opencode's 4096 default.
 */
const LOCK_PORT = Number(process.env.OPENCODE_NOTIFY_QQ_LOCK_PORT ?? 4097);

/**
 * Records this bridge's identity ({pid, hash}) so the plugin can tell whether
 * the running daemon is from the current source. Without it, a bridge spawned
 * detached from an older build is reused forever (the lock port makes startup
 * idempotent), and every bridge change needs a manual kill.
 */
const STATE_PATH = process.env.OPENCODE_NOTIFY_QQ_BRIDGE_STATE;

function writeState(): void {
  if (!STATE_PATH) return;
  try {
    writeFileSync(
      STATE_PATH,
      JSON.stringify({
        pid: process.pid,
        hash: process.env.OPENCODE_NOTIFY_QQ_BRIDGE_HASH ?? "",
        startedAt: Date.now(),
      }),
      "utf8",
    );
  } catch {
    /* the state file is an optimization; never block startup on it */
  }
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} [bridge] ${message}`);
}

/** One-line preview of a command body for the log. */
function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// opencode HTTP client
// ---------------------------------------------------------------------------

type OpencodeEvent = { id?: string; type?: string; data?: Record<string, unknown> };
type Session = {
  id: string;
  directory?: string;
  agent?: string;
  parentID?: string;
  title?: string;
  metadata?: { aside?: boolean };
  time?: { created?: number; updated?: number };
};

let sessions: Session[] | null = null;
let sessionsAt = 0;

/**
 * All sessions, cached briefly.
 *
 * `limit` is raised because the default page is too small to decide which
 * sessions are still alive for numbering reclamation.
 */
async function allSessions(): Promise<Session[]> {
  if (!sessions || Date.now() - sessionsAt > 60_000) {
    const page = await client().session.list({ limit: 1000 });
    sessions = (page.data ?? []).map((s) => ({
      id: s.id,
      directory: s.location?.directory,
      agent: s.agent,
      parentID: s.parentID,
      // Everything `.list` and the aside labels show: dropping these made every
      // row look like a bare directory.
      title: (s as { title?: string }).title,
      metadata: (s as { metadata?: { aside?: boolean } }).metadata,
      time: (s as { time?: { created?: number; updated?: number } }).time,
    }));
    sessionsAt = Date.now();
  }
  return sessions ?? [];
}

/** Session list changes rarely; cache it so each permission is one round-trip. */
async function sessionInfo(sessionID: string): Promise<Session> {
  return (await allSessions()).find((s) => s.id === sessionID) ?? { id: sessionID };
}

async function sessionDirectory(sessionID: string): Promise<string> {
  return (await sessionInfo(sessionID)).directory ?? "(unknown)";
}

/**
 * Busy-ness, observed and then calibrated against the server.
 *
 * V1 asked `GET /session/status`, which V2 does not have. A step starting means
 * work is in flight; a step that ends without wanting a tool call means the turn
 * is over. `session.active()` reports the drains this process owns, and is only
 * consulted as a fallback.
 *
 * On a failed probe this returns TRUE (assume busy). The two mistakes are not
 * equal: wrongly queueing is harmless (the message waits for an idle that will
 * come), while wrongly assuming idle injects the message straight into the turn -
 * turning `.task` into an interruption, which is the opposite of what it means.
 */
const busySessions = new Set<string>();

function noteBusy(sessionID: string | undefined, busy: boolean): void {
  if (!sessionID) return;
  if (busy) busySessions.add(sessionID);
  else busySessions.delete(sessionID);
}

async function sessionIsBusy(sessionID: string): Promise<boolean> {
  if (busySessions.has(sessionID)) return true;
  try {
    const active = await client().session.active();
    if (sessionID in active) {
      busySessions.add(sessionID);
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pending requests
// ---------------------------------------------------------------------------

type Pending = { requestID: string; sessionID: string; permission: string };

const pending = new Map<string, Pending>();

/** A form the agent is waiting on (`question` tool); answering it unblocks the run. */
type FormField = {
  key?: string;
  type?: string;
  title?: string;
  options?: Array<{ value?: string; label?: string }>;
};
type PendingForm = { formID: string; sessionID: string; question: string; fields: FormField[] };

const pendingForms = new Map<string, PendingForm>();

type Verdict = "once" | "always" | "reject";

/**
 * Tolerant reply parsing. Accepts, case-insensitively and ignoring a leading
 * `.` or full-width `.`:
 *   o / once / 批准      -> once
 *   a / always / 记住    -> always
 *   r / reject / 拒绝    -> reject
 * A leading dot lets these collide-free with the future `.task` / `.ask`
 * command family.
 */
const REPLY_ALIASES: Record<string, Verdict> = {
  o: "once",
  once: "once",
  批准: "once",
  同意: "once",
  a: "always",
  always: "always",
  记住: "always",
  总是: "always",
  r: "reject",
  reject: "reject",
  拒绝: "reject",
};

/// The optional "#N" a reply carries: `.a #2` answers session #2's request.
export function replyTarget(text: string): number | undefined {
  const m = text.match(/#\s*(\d+)\b/);
  return m ? Number(m[1]) : undefined;
}

export function parseReply(text: string): Verdict | undefined {
  const key = text.trim().replace(/^[.．。]/, "").trim().toLowerCase().replace(/#\s*\d+\s*$/, "").trim();
  return REPLY_ALIASES[key];
}

// ---------------------------------------------------------------------------
// Remote commands
// ---------------------------------------------------------------------------

export type Command =
  | { kind: "task" | "ask" | "btw" | "bt" | "answer"; text: string; target?: number }
  | { kind: "stop"; target?: number }
  | { kind: "list"; target?: number }
  | { kind: "status"; target?: number };

/**
 * Parse a leading-dot command. Returns undefined for anything else, so ordinary
 * chatter and o/a/r replies pass through untouched.
 *
 *   .task <text>      queue a message; runs after the current turn (or now if idle)
 *   .ask  <text>      steer into the running turn immediately
 *   .btw  <question>  one-shot answer from the session's context, without touching
 *                     the conversation or the running turn
 *   .bt   <question>  side question that MAY use tools: answered in a throwaway
 *                     fork of the session, so it still leaves no trace
 *   .answer <text>    answer the question the agent is waiting on (`.answer` with
 *                     nothing waiting is a no-op)
 *   .stop             abort the running turn (highest priority)
 *   .status           report the target session's turn/tool state (stuck detector)
 *   .list             list the sessions this bridge can address, with their #N
 *
 * Any command may name a session by number: `.stop #2`, `.task #1 do x`. The
 * leading dot accepts ASCII, full-width, or the Chinese ideographic full stop,
 * since a phone IME often produces the last one.
 */
export function parseCommand(text: string): Command | undefined {
  const m = text.trim().match(/^[.．。]\s*(task|ask|btw|bt|answer|stop|status|list)\b\s*([\s\S]*)$/i);
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase() as "task" | "ask" | "btw" | "bt" | "answer" | "stop" | "status" | "list";
  let rest = (m[2] ?? "").trim();

  // Optional leading "#N" target. Stripped before the body is taken, so
  // `.task #2 deploy` has body "deploy" and target 2.
  let target: number | undefined;
  const t = rest.match(/^#\s*(\d+)\b\s*([\s\S]*)$/);
  if (t) {
    target = Number(t[1]);
    rest = (t[2] ?? "").trim();
  }

  if (kind === "stop" || kind === "status" || kind === "list") return { kind, target };
  if (!rest) return undefined; // a bare ".task" with no body is not a command
  return { kind, text: rest, target };
}

/** The session a command should act on: the most recent one we have seen. */
let lastSessionID: string | null = null;

/** Wall-clock of the most recent opencode event, for `.status` liveness. */
let lastEventAt = 0;

/** The live gateway client, set in run(); `.status` reads its connection state. */
let gateway: QqBotClient | null = null;

/** Stable short numbers so a phone reply can name a session (shared via file). */
const sessionNumbers = new SessionNumbers(sessionNumbersPath());

/**
 * Messages deferred to the end of the running turn.
 *
 * opencode has no working "deliver after this turn" route: `prompt_async` (the
 * only one that delivers) always steers into the running turn, and the v2
 * `delivery:"queue"` flag is accepted but never honoured. So `.task` - which
 * means "after you finish, do this" - is queued HERE and released when the
 * session reports idle.
 */
const taskQueue = new TaskQueue();

/**
 * Sessions currently being drained. One finished turn emits several idle
 * signals; without this guard two of them would race and send the same queued
 * text twice.
 */
const draining = new Set<string>();

/**
 * Record a session from an event and return its display number.
 *
 * Subagent sessions do not get numbers: they are ephemeral and would inflate
 * the count, and you never need to address one remotely. They still set
 * lastSessionID so untargeted commands hit the session that is actually active.
 */
function rememberSession(sessionID: string): number | undefined {
  // Our own aside fork: it may be named (`.stop #N`) while it runs, but it must
  // not become the default target - an untagged command still means the session
  // the user is actually looking at.
  if (asideIds.has(sessionID) || asideSeen.has(sessionID)) return sessionNumbers.numberFor(sessionID);
  lastSessionID = sessionID;
  if (subagentIds.has(sessionID)) return undefined;
  return sessionNumbers.numberFor(sessionID);
}

/** Sessions known to be subagents (have a parentID). */
const subagentIds = new Set<string>();

/**
 * Asides seen in the session list. A fork carries no parentID, so the list is
 * the only way to recognise one after a bridge restart - which would otherwise
 * let a running aside take a number and become the default target.
 */
const asideSeen = new Set<string>();

/** True for a `.bt` aside fork, marked by this bridge (title is the fallback). */
export function isAsideSession(session: { title?: string; metadata?: { aside?: boolean } }): boolean {
  return session.metadata?.aside === true || Boolean(session.title?.startsWith("旁问 ·"));
}

/**
 * Forks this process created for `.bt`. Unlike a subagent, a fork carries no
 * parentID, so without this it would take a session number and become the
 * default target: an untagged command would then hit the side question while
 * the real session sits right there.
 */
const asideIds = new Set<string>();
let registryAt = 0;

/**
 * How many recent main sessions keep a number.
 *
 * Numbers would otherwise climb forever, since every session that ever emitted
 * an event would hold one. Only recent ones matter (you reply to a notification
 * you just received), so older ones are released and their numbers reused.
 */
const NUMBER_WINDOW = Number(process.env.OPENCODE_NOTIFY_QQ_NUMBER_WINDOW ?? 30);

/**
 * Refresh the subagent set and reclaim numbers from stale sessions.
 *
 * Throttled: the session list barely changes, and this runs on every event.
 */
async function refreshSessionRegistry(): Promise<void> {
  if (Date.now() - registryAt < 30_000) return;
  registryAt = Date.now();

  const list = await allSessions();
  if (!list.length) return; // fetch failed; never wipe numbers on empty data

  subagentIds.clear();
  asideSeen.clear();
  const main = list.filter((s) => {
    if (s.parentID) {
      subagentIds.add(s.id);
      return false;
    }
    // An aside of ours is not the user's session: no number, never the default.
    if (isAsideSession(s)) {
      asideSeen.add(s.id);
      return false;
    }
    return true;
  });
  // Most recently updated main sessions keep their numbers.
  const recent = main
    .sort((a, b) => ((b as { time?: { updated?: number } }).time?.updated ?? 0) - ((a as { time?: { updated?: number } }).time?.updated ?? 0))
    .slice(0, NUMBER_WINDOW)
    .map((s) => s.id);
  sessionNumbers.prune(new Set([...recent, ...asideSeen]));
}

/**
 * Fallback target when no event has been seen yet: the most recently updated
 * MAIN session. Without this, `.stop` right after startup says "no known
 * session" even though there is an obvious candidate. Subagents are excluded -
 * aborting one is never what you meant.
 */
async function mostRecentSession(): Promise<string | null> {
  const main = (await allSessions()).filter((s) => !s.parentID && !isAsideSession(s));
  const sorted = [...main].sort(
    (a, b) =>
      ((b as { time?: { updated?: number } }).time?.updated ?? 0) -
      ((a as { time?: { updated?: number } }).time?.updated ?? 0),
  );
  return sorted[0]?.id ?? null;
}

/**
 * Resolve which session a command targets.
 *
 * An explicit "#N" wins (and says so when unknown). Otherwise the most recent
 * session we have seen, then the most recently updated one as a startup
 * fallback. `num` is absent only if the target is a subagent, which cannot be
 * named but can still be acted on by an untargeted command.
 */
async function resolveTarget(target?: number): Promise<{ id: string; num?: number } | null> {
  if (target !== undefined) {
    const id = sessionNumbers.resolve(target);
    return id ? { id, num: target } : null;
  }
  const id = lastSessionID ?? (await mostRecentSession());
  if (!id) return null;
  return { id, num: rememberSession(id) };
}

/**
 * Release one queued `.task` for a session whose turn just ended.
 *
 * One at a time: sending starts a new turn, so the next item waits for the next
 * idle. That keeps a burst of `.task` messages in order instead of merging them.
 * If the send fails the item is put back, so a transient error does not lose it.
 */
async function drainQueue(sessionID: string): Promise<void> {
  const text = taskQueue.peek(sessionID);
  if (!text || draining.has(sessionID)) return;
  draining.add(sessionID);
  try {
    await prompt(sessionID, text);
    // The queued command started this turn, so its result is a reply: mark it
    // before the turn ends, for the plugin to report regardless of the switch.
    markCommandOutcome(sessionID);
    taskQueue.shift(sessionID);
    const rest = taskQueue.size(sessionID);
    const num = sessionNumbers.lookup(sessionID);
    await sendText(`开始排队任务${num !== undefined ? ` #${num}` : ""}: ${text.slice(0, 80)}`);
    log(`task drained from ${sessionID} (${rest} pending): ${preview(text)}`);
  } catch (cause) {
    log(`drain failed, keeping queued: ${cause instanceof Error ? cause.message : cause}`);
  } finally {
    // Hold the guard briefly so the idle burst that triggered this cannot
    // immediately start the next item; the next real idle will.
    setTimeout(() => draining.delete(sessionID), 2000);
  }
}

/** Compact duration for a phone: "45s" / "3m12s" / "1h02m". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** "12s 前" / "4m00s 前" / "无". */
export function fmtAgo(ms: number | null | undefined): string {
  return ms == null ? "无" : `${fmtDuration(ms)} 前`;
}

/** How long a running tool may run before its line is flagged as possibly stuck. */
const STUCK_MS = Number(process.env.OPENCODE_NOTIFY_QQ_STUCK_MS ?? 90_000);

/** Default number of transcript lines `.status` shows. */
const STATUS_LINES = Number(process.env.OPENCODE_NOTIFY_QQ_STATUS_LINES ?? 15);
/** How many sessions `.list` shows at most (recent first). */
const LIST_LINES = Number(process.env.OPENCODE_NOTIFY_QQ_LIST_LINES ?? 8);
/** How long a finished aside branch still shows in `.list` (it holds a number). */
const ASIDE_LIST_MS = Number(process.env.OPENCODE_NOTIFY_QQ_ASIDE_LIST_MS ?? 600_000);

/** Max lines one text/reasoning part may contribute. */
const PART_LINES = 4;

/** Max characters per transcript line. */
const LINE_CHARS = 120;
/** How long `.bt` waits for its tool-using turn before it reports a timeout. */
const ASIDE_TIMEOUT_MS = Number(process.env.OPENCODE_NOTIFY_QQ_ASIDE_TIMEOUT_MS ?? 300_000);
/** Absolute cap on one aside even while approvals are pending: no runaway side questions. */
const ASIDE_MAX_MS = Number(process.env.OPENCODE_NOTIFY_QQ_ASIDE_MAX_MS ?? 900_000);

/** V2 content parts: assistant output is tagged `text` | `reasoning` | `tool`. */
type Part = {
  type?: string;
  text?: string;
  name?: string;
  state?: { status?: string; input?: Record<string, unknown> | string };
  time?: { created?: number; ran?: number; completed?: number };
};
/** V2 messages are tagged themselves; there is no `{ info, parts }` wrapper. */
type Msg = {
  type?: string;
  text?: string;
  content?: Part[];
  finish?: string;
  time?: { created?: number; completed?: number };
};

/** Wrap a text blob into trimmed, capped display lines. */
function clipLines(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l));
  if (lines.length <= PART_LINES) return lines;
  return [...lines.slice(0, PART_LINES - 1), "…"];
}

/** One "工具> ..." line: name, status/stuck flag, and the command it runs. */
function toolLine(p: Part): string {
  const status = p.state?.status;
  const start = p.time?.ran ?? p.time?.created;
  let label: string;
  if (status === "running" || status === "streaming") {
    const ms = typeof start === "number" ? Date.now() - start : null;
    label = `运行中${ms != null ? ` ${fmtDuration(ms)}` : ""}${ms != null && ms > STUCK_MS ? "，可能卡住" : ""}`;
  } else if (status === "error") {
    label = "失败";
  } else if (status === "completed") {
    label = "完成";
  } else {
    label = status ?? "排队";
  }
  // Tools put their subject in different input keys (shell: command, edit/read:
  // filePath, glob/grep: pattern); show the first one that is a string.
  const input = p.state?.input;
  let raw = "";
  if (typeof input === "object" && input !== null) {
    for (const key of ["command", "filePath", "filepath", "path", "pattern", "url"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value) {
        raw = value;
        break;
      }
    }
  }
  const detail = raw.replace(/\s+/g, " ").trim().slice(0, 160);
  return `${p.name ?? "?"} [${label}]${detail ? ` ${detail}` : ""}`;
}

/**
 * Turn the session's recent messages into labeled transcript lines.
 *
 * Pure, so the mapping is testable without a server. Reasoning and assistant
 * text get "思考>" / "输出>" so it is obvious which is which; tools get a single
 * line with their status. User text is skipped (you already know what you sent).
 */
export function renderTranscript(msgs: Msg[], maxLines = STATUS_LINES): string[] {
  const lines: string[] = [];
  for (const m of msgs) {
    // User text is skipped: you already know what you sent.
    if (m.type === "user") continue;
    for (const p of m.content ?? []) {
      if (p.type === "reasoning" && p.text) {
        for (const l of clipLines(p.text)) lines.push(`思考> ${l}`);
      } else if (p.type === "text" && p.text) {
        for (const l of clipLines(p.text)) lines.push(`输出> ${l}`);
      } else if (p.type === "tool") {
        lines.push(`工具> ${toolLine(p)}`);
      }
    }
  }
  return lines.slice(-maxLines);
}

type SessionSnapshot = { transcript: string[]; turnStart?: number; lastActivity?: number };

/** Fetch the transcript and derive the turn start plus last-activity times. */
/** Raw messages of a session. The context route returns the array itself. */
async function sessionMessages(sessionID: string): Promise<Msg[]> {
  const raw = (await client().session.context({ sessionID })) as unknown;
  return Array.isArray(raw) ? (raw as Msg[]) : ((raw as { messages?: Msg[] })?.messages ?? []);
}

/**
 * The answer of a forked turn: the last assistant text after the inherited
 * prefix. Starting at `from` keeps a fork that only made tool calls from
 * quoting the parent's own words back at you.
 */
export function lastAssistantText(msgs: Msg[], from: number): string {
  for (let i = msgs.length - 1; i >= from; i--) {
    const msg = msgs[i];
    if (msg?.type !== "assistant") continue;
    const text = (msg.content ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text!)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * True when the forked turn is over.
 *
 * A turn ends with an `idle` marker (`outcome: succeeded|failed`); the answer
 * itself is the assistant message just before it. The terminal-finish check
 * covers the moment before that marker is written. Pure, so the rule is testable.
 */
export function turnEnded(tail: Msg[]): boolean {
  if (!tail.some((m) => m.type === "assistant")) return false;
  // The idle marker only ends the turn when it is the LAST message. A turn that
  // pauses for an approval writes one too, and treating that as "answered" is
  // exactly how an aside got its branch deleted while the approval was still on
  // the phone.
  if (tail[tail.length - 1]?.type === "idle") return true;
  return tail.some(
    (m) => m.type === "assistant" && Boolean(m.finish) && m.finish !== "tool-calls" && Boolean(m.time?.completed),
  );
}

/** Is this session waiting for an approval right now? */
function sessionHasPending(sessionID: string): boolean {
  for (const p of pending.values()) if (p.sessionID === sessionID) return true;
  return false;
}

/**
 * Poll the fork's transcript until its turn is over. Reading the transcript keeps
 * this off the event bookkeeping, which only tracks sessions we are told about.
 *
 * Time spent waiting for the user's approval does not count against the timeout:
 * an aside that stopped to ask is not a stuck aside.
 */
async function waitForTurnEnd(sessionID: string, baseline: number, timeoutMs: number): Promise<boolean> {
  const hardStop = Date.now() + ASIDE_MAX_MS;
  let deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(700);
    // A runaway aside (a "go test the TUI" can turn into hundreds of steps) is
    // worse than a missing answer, so approvals do not extend this cap.
    if (Date.now() >= hardStop) return false;
    if (sessionHasPending(sessionID)) {
      deadline = Date.now() + timeoutMs;
      continue;
    }
    const msgs = await sessionMessages(sessionID).catch(() => [] as Msg[]);
    if (turnEnded(msgs.slice(baseline))) return true;
    if (Date.now() >= deadline) return false;
  }
}

/**
 * Permission rules for `.bt`, by mode.
 *
 * "guarded" deliberately leaves the broad rules in place and adds the sandbox
 * exception last (the last matching rule wins): a write inside the fork's own
 * sandbox is free, anything else asks. Pure, so the set is testable.
 */
export function asideRules(
  mode: "readonly" | "guarded" | "full",
  sandbox: string,
): { action: string; resource: string; effect: "allow" | "deny" | "ask" }[] {
  if (mode === "full") return [];
  const read = (["read", "glob", "grep", "webfetch", "websearch"] as const).map((action) => ({
    action,
    resource: "*",
    effect: "allow" as const,
  }));
  if (mode === "readonly") {
    return [
      ...read,
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ];
  }
  return [
    ...read,
    { action: "edit", resource: "*", effect: "ask" },
    // Rules match normalized paths (slashes, case-insensitive on Windows).
    { action: "edit", resource: `${sandbox.replace(/\\/g, "/")}/*`, effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
  ];
}

async function fetchSessionSnapshot(sessionID: string): Promise<SessionSnapshot> {
  try {
    const msgs = (await client().session.context({ sessionID })) as unknown as Msg[];
    if (!Array.isArray(msgs)) return { transcript: [] };

    let turnStart: number | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.type === "user") {
        turnStart = msgs[i]?.time?.created;
        break;
      }
    }
    const last = msgs[msgs.length - 1];
    const lastActivity = last?.time?.completed ?? last?.time?.created;
    return { transcript: renderTranscript(msgs), turnStart, lastActivity };
  } catch {
    return { transcript: [] };
  }
}

/** One row of `.list`. */
export type ListRow = { num: number; directory: string; state: string; title?: string };

/**
 * Render `.list`: one line per numbered session, most recent first. Pure, so the
 * layout is testable.
 */
export function formatList(rows: ListRow[], max = 8): string {
  if (!rows.length) {
    return "这台机器上还没有见过会话；等 opencode 报一个事件（或发一条 `.status`）之后再看。";
  }
  const shown = rows.slice(0, max);
  const head = `**opencode · 会话列表**（最近 ${shown.length}${rows.length > shown.length ? ` / 共 ${rows.length}` : ""}）`;
  const lines = shown.map((row) => {
    // Title first: several sessions can share one directory, so the directory
    // alone does not tell them apart.
    const name = row.title ? row.title.slice(0, 40) : row.directory;
    return `#${row.num} ${name} · ${row.state} · \`${row.directory}\``;
  });
  return [head, ...lines].join("\n");
}

/** Scratch directory for a `.bt` fork: writes here need no approval. */
function asideSandbox(forkID: string): string {
  return join(tmpdir(), "opencode", "aside", forkID);
}

/**
 * The framing every `.btw` / `.bt` prompt carries: those answers are read on a
 * phone, come from a throwaway context, and are not a work order. The user's own
 * words (`asidePrompt` in the config file) go last, so they win.
 */
export function asideFraming(
  kind: "btw" | "bt",
  extra = loadConfig().asidePrompt,
  sandbox?: string,
  mode: "readonly" | "guarded" | "full" = loadConfig().asideTools,
): string {
  const shared = [
    "【QQ 旁问】用户不在电脑前，你这段回答会作为一条 QQ 消息直接推到他手机上。请照这个来写：",
    "1. 先给结论，再给必要的依据；手机屏幕小，能短就短，不要贴大段代码或长表格；",
    "2. 不要复述问题、不要汇报过程、不要给「下一步计划」，也不要反问「要不要我继续」；",
    "3. 用户问的多半是「这是什么 / 为什么 / 怎么办」—— 直接回答即可：不要为了回答去改文件、跑命令或做实验（需要动手的，他会用 .ask / .task）；",
    "4. 用中文，把话说清楚，别堆术语。",
  ].join("\n");
  // The wording has to follow the permission mode: promising approvals under
  // "full" (where nothing asks) would be plainly wrong.
  const abilities: Record<"readonly" | "guarded" | "full", string> = {
    readonly:
      "你在一份用完即弃的只读分支里（主会话不受影响）：可以读文件、搜索、查资料，但改不了文件、也跑不了命令",
    guarded: `你在一份用完即弃的临时分支里（主会话不受影响）：可以读文件、搜索、查资料；改工作区文件或执行命令都会弹审批推到用户手机上${
      sandbox ? `，而写进沙盒目录 ${sandbox} 不用审批` : ""
    }`,
    full: "你在一份用完即弃的临时分支里（主会话不受影响）：读文件、搜索、改文件、执行命令都可以 —— 这一档不会弹审批，所以更要克制，只做回答这件事所需的最小动作",
  };
  const tools =
    kind === "btw"
      ? "另外：你没有工具可用 —— 如果回答需要读文件、查网页或跑命令，就用一句话说明「这要看代码/跑一下，请用 .ask 问我」，不要猜、不要编。"
      : [`另外：${abilities[mode]}。`, "如果回答必须动手改或跑才能给出，就用一句话请他改用 .ask 问我。"].join("\n");
  return [shared, tools, ...(extra ? [extra] : [])].join("\n");
}

/**
 * Render the `.status` reply. Pure so the layout is testable: a one-line state
 * header, then the last `lines` transcript lines.
 */
export function formatStatus(input: {
  session: string;
  gateway: boolean;
  pending: number;
  busy: boolean;
  turnMs?: number | null;
  eventAgeMs?: number | null;
  lastActivityMs?: number | null;
  transcript: string[];
  lines?: number;
}): string {
  const stateText = input.busy
    ? `运行中${input.turnMs != null ? ` ${fmtDuration(input.turnMs)}` : ""}`
    : `空闲${input.lastActivityMs != null ? `（最后活动 ${fmtDuration(input.lastActivityMs)} 前）` : ""}`;
  const health = `事件 ${fmtAgo(input.eventAgeMs)} | 待审批 ${input.pending} | 网关 ${input.gateway ? "connected" : "disconnected"}`;
  const head = `会话 ${input.session} · ${stateText} | ${health}`;
  const tail = input.transcript.slice(-(input.lines ?? STATUS_LINES));
  return [head, ...tail].join("\n");
}

/** Gather live state and reply with it. */
/**
 * Should this aside branch show up in `.list`?
 *
 * Branches are otherwise hidden, but one that is still running - or was
 * interrupted and left behind - holds a number, so hiding it would leave an
 * unexplained gap and no way to name it for `.stop`.
 */
export function asideVisibleInList(
  session: { time?: { updated?: number } },
  now: number,
  busy: boolean,
  windowMs = ASIDE_LIST_MS,
): boolean {
  return busy || now - (session.time?.updated ?? 0) <= windowMs;
}

/** Reply to `.list`: the sessions you can address, most recent first. */
async function sendList(): Promise<void> {
  const now = Date.now();
  const rows = (await allSessions())
    .filter((s) => !s.parentID)
    .filter((s) => !isAsideSession(s) || asideVisibleInList(s, now, busySessions.has(s.id)))
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .slice(0, LIST_LINES)
    .map((s): ListRow => {
      // Listing is how you address them, so hand out numbers here: whatever the
      // list shows can be named in the next command.
      const state = busySessions.has(s.id)
        ? "运行中"
        : `空闲（${fmtAgo(s.time?.updated ? now - s.time.updated : null)}）`;
      return {
        num: sessionNumbers.numberFor(s.id),
        directory: s.directory ?? "?",
        state: isAsideSession(s) ? `旁问分支 · ${state}` : state,
        title: s.title,
      };
    });
  await sendText(formatList(rows, LIST_LINES));
  log(`command: list (${rows.length} shown)`);
}

async function sendStatus(target?: number): Promise<void> {
  const resolved = await resolveTarget(target);
  const id = resolved?.id ?? null;
  const dir = id ? await sessionDirectory(id) : undefined;
  const session = dir ? (resolved?.num !== undefined ? `#${resolved.num} ${dir}` : dir) : "无";
  const busy = id ? await sessionIsBusy(id) : false;
  const snap: SessionSnapshot = id ? await fetchSessionSnapshot(id) : { transcript: [] };
  await reconcilePending();

  const text = formatStatus({
    session,
    gateway: gateway?.connected ?? false,
    pending: pending.size,
    busy,
    turnMs: busy && snap.turnStart ? Date.now() - snap.turnStart : null,
    eventAgeMs: lastEventAt ? Date.now() - lastEventAt : null,
    lastActivityMs: snap.lastActivity != null ? Date.now() - snap.lastActivity : null,
    transcript: snap.transcript,
  });
  await sendText(text);
  log("command: status");
}

/**
 * Answer `.bt`: a side question that may use tools.
 *
 * The question runs in a fork of the session, so it sees the conversation and
 * gets working tools, and the fork is deleted afterwards - nothing of it shows
 * up in the real transcript. Runs detached: a tool-using turn takes minutes, and
 * `.stop` plus approvals must not queue behind it.
 */
type AsideRun = { forkID?: string; forkNum?: number; answer: string; finished: boolean; error?: string };

/**
 * Run one aside to completion: fork the session, scope it, ask, wait, read the
 * answer, then delete the fork and its sandbox. Never throws - both callers (QQ
 * `.bt` and the TUI `/bt`) have to say something either way.
 */
async function runAsideCore(
  target: string,
  question: string,
  onReady?: (info: { forkNum?: number; agent: string; agentError?: string }) => Promise<void> | void,
): Promise<AsideRun> {
  let forkID: string | undefined;
  let forkNum: number | undefined;
  try {
    const fork = await client().session.fork({ sessionID: target });
    forkID = fork?.id;
    if (!forkID) throw new Error("fork 没有返回会话 id");

    // Register before anything else can report it: to us a fork must never become
    // the default target, and the metadata is what the plugins read to stay quiet
    // about it. It does get a number, so a reply can name the branch.
    asideIds.add(forkID);
    forkNum = rememberSession(forkID);

    const config = loadConfig();
    const sandbox = asideSandbox(forkID);
    mkdirSync(sandbox, { recursive: true });

    // A fork inherits the session's agent, whose toolset may have no file access
    // at all - the aside would then be unable to read anything. Switch it to a
    // known-good agent unless the config says to inherit.
    let agentError: string | undefined;
    if (config.asideAgent !== "inherit") {
      try {
        await client().session.switchAgent({ sessionID: forkID, agent: config.asideAgent });
      } catch (cause) {
        agentError = cause instanceof Error ? cause.message : String(cause);
        log(`aside agent switch to ${config.asideAgent} failed: ${agentError}`);
      }
    }
    if (onReady) await onReady({ forkNum, agent: config.asideAgent, agentError });

    const rules = asideRules(config.asideTools, sandbox);
    await client().session.update({
      sessionID: forkID,
      title: `旁问 · ${question.slice(0, 40)}`,
      metadata: { aside: true },
      ...(rules.length ? { permissions: rules } : {}),
    });

    const baseline = (await sessionMessages(forkID)).length;
    await client().session.prompt({
      sessionID: forkID,
      text: `${asideFraming("bt", config.asidePrompt, sandbox, config.asideTools)}\n\n${question}`,
    });
    const finished = await waitForTurnEnd(forkID, baseline, ASIDE_TIMEOUT_MS);
    const answer = lastAssistantText(await sessionMessages(forkID), baseline).trim();
    return { forkID, forkNum, answer, finished };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    log(`aside failed for ${target}: ${error}`);
    return { forkID, forkNum, answer: "", finished: false, error };
  } finally {
    if (forkID) {
      asideIds.delete(forkID);
      await client().session.remove({ sessionID: forkID }).catch(() => {});
      try {
        rmSync(asideSandbox(forkID), { recursive: true, force: true });
      } catch {
        /* a handle may still hold the directory; leaving it is harmless */
      }
    }
  }
}

/** The closing text of an aside, with the reason when there is none. */
function asideBody(run: AsideRun, max = 3500): string {
  if (!run.answer) return run.finished ? "(没有内容)" : "(超时 —— 这一轮还没答完，先用 .status 看看)";
  return run.answer.length > max ? `${run.answer.slice(0, max)}...` : run.answer;
}

/**
 * `.bt` from QQ: acknowledge with the branch and its agent, run, push the answer.
 *
 * Detached by the caller: a tool-using turn takes minutes, and `.stop` plus
 * approvals must not queue behind it.
 */
async function runAside(target: string, num: number | undefined, tag: string, question: string): Promise<void> {
  const run = await runAsideCore(target, question, async ({ forkNum, agent, agentError }) => {
    const who = agentError
      ? `agent 换不上（${agentError}），沿用会话自己的`
      : agent === "inherit"
        ? "agent 沿用会话自己的"
        : `agent ${agent}`;
    await sendText(`旁问(工具)已发出：分支 #${forkNum} · ${who} · 问 ${tag}，跑完回你：${question.slice(0, 80)}`);
  });
  if (run.error) {
    await sendText(`旁问(工具)失败 ${tag}：${run.error}`);
    return;
  }
  const asked = num !== undefined ? `问 #${num}` : "问当前会话";
  await sendWithRetry(
    `**opencode · 旁问(工具) · ${asked}**\n\n\`分支 #${run.forkNum} · ${tag}\` ${question.slice(0, 80)}\n\n---\n\n${asideBody(run)}`,
  );
  log(`bt answered for ${target} via ${run.forkID} (${run.finished ? "done" : "timeout"}): ${preview(question)}`);
}

/**
 * `/bt` from the TUI: the same run, but the answer goes back into the session it
 * was asked from, as a synthetic message.
 */
async function runAsideTui(sessionID: string, question: string): Promise<void> {
  const run = await runAsideCore(sessionID, question);
  const branch = run.forkNum !== undefined ? `（分支 #${run.forkNum}）` : "";
  const body = run.error ? `失败：${run.error}` : asideBody(run, 12_000);
  try {
    await client().session.synthetic({ sessionID, text: `**旁问${branch}**\n\n${body}` });
    log(`bt(tui) answered for ${sessionID}: ${preview(question)}`);
  } catch (cause) {
    log(`bt(tui) could not post the answer: ${cause instanceof Error ? cause.message : cause}`);
  }
}

async function runCommand(cmd: Command): Promise<void> {
  if (cmd.kind === "status") {
    await sendStatus(cmd.target);
    return;
  }
  if (cmd.kind === "list") {
    await sendList();
    return;
  }
  const resolved = await resolveTarget(cmd.target);
  if (!resolved) {
    const why = cmd.target !== undefined ? `未知会话编号 #${cmd.target}` : "没有已知会话";
    await sendText(`${why}，无法执行 .${cmd.kind}`);
    return;
  }
  const { id: target, num } = resolved;
  const tag = `[${num !== undefined ? `#${num} ` : ""}${await sessionDirectory(target)}]`;
  try {
    if (cmd.kind === "stop") {
      await client().session.interrupt({ sessionID: target });
      await sendText(`已中断 ${tag}`);
      log("command: stop");
      return;
    }

    // .btw asks a side question: it is answered from the session's context and is
    // not added to the conversation, so it disturbs neither the running turn nor
    // the transcript. A model call takes seconds, so acknowledge first - `.task`
    // answers immediately and the silence here would look like a failure.
    // .bt is the side question that may use tools: fork the session (so the
    // question understands what you were talking about), let it read and search,
    // then throw the fork away. Detached, because `.stop` must stay responsive.
    if (cmd.kind === "bt") {
      // The ack goes out once the fork exists, so it can name the branch number.
      void runAside(target, num, tag, cmd.text);
      return;
    }

    if (cmd.kind === "btw") {
      await sendText(`旁问已发出 ${tag}，稍后回你：${cmd.text.slice(0, 80)}`);

      // Generation mode cannot call tools: a reply that tries to (read a file,
      // look something up) comes back empty or stops mid-sentence. Say so, and
      // say "don't guess" too - silence alone would invite making something up.
      const prompt = `${asideFraming("btw")}\n\n${cmd.text}`;
      const answer = (await client().session.generate({ sessionID: target, prompt })).text.trim();
      const body = answer
        ? answer.length > 3500
          ? `${answer.slice(0, 3500)}...`
          : answer
        : "(没有内容 —— 这个问题大概需要读文件/查网页，旁问用不了工具，改用 .ask 吧)";
      const heading = num !== undefined ? `**opencode · 旁问 · #${num}**` : `**opencode · 旁问**`;
      await sendWithRetry(`${heading}\n\n\`${tag}\` ${cmd.text.slice(0, 80)}\n\n---\n\n${body}`);
      log(`btw answered for ${target}: ${preview(cmd.text)}`);
      return;
    }

    // .answer replies to the question the agent is waiting on. With nothing
    // waiting it is a no-op, exactly like a stale approval reply.
    if (cmd.kind === "answer") {
      await reconcileForms(target);
      const form = [...pendingForms.values()].find((f) => f.sessionID === target);
      if (!form) {
        await sendText(`没有待回答的问题（可能已在电脑上处理）· ${tag}`);
        log("answer ignored: no pending form");
        return;
      }
      const answer = buildAnswer(form.fields, cmd.text);
      if (!answer) throw new Error("这个表单没有可回答的字段");
      await client().session.form.reply({ sessionID: target, formID: form.formID, answer });
      pendingForms.delete(form.formID);
      await sendText(`已回答 ${tag}: ${cmd.text.slice(0, 60)}`);
      log(`form ${form.formID} answered`);
      return;
    }

    if (cmd.kind === "ask") {
      // .ask means "steer into the running turn"; the default delivery does that.
      await prompt(target, cmd.text);
      markCommandOutcome(target);
      await sendText(`已插话 ${tag}: ${cmd.text.slice(0, 80)}`);
      log(`ask steered into ${target}: ${preview(cmd.text)}`);
      return;
    }

    // .task means "when you finish, do this". If a turn is running, hold it and
    // release on the turn end; otherwise there is nothing to wait for, send now.
    if (await sessionIsBusy(target)) {
      const n = taskQueue.push(target, cmd.text);
      await sendText(`已排队 ${tag}（本轮结束后执行，队列 ${n} 条）: ${cmd.text.slice(0, 80)}`);
      log(`task queued for ${target} (${n} pending): ${preview(cmd.text)}`);
      return;
    }
    await prompt(target, cmd.text);
    markCommandOutcome(target);
    await sendText(`已发送 ${tag}: ${cmd.text.slice(0, 80)}`);
    log(`task sent now (idle) to ${target}: ${preview(cmd.text)}`);
  } catch (cause) {
    const hint = cmd.kind === "btw" ? "（会话可能正忙，稍后再试或先 .status）" : "";
    await sendText(`.${cmd.kind} 失败${hint}: ${cause instanceof Error ? cause.message : cause}`);
  }
}

/**
 * Inject a message into a session.
 *
 * The bridge queues `.task` itself (see `drainQueue`) and only sends once the
 * turn is over, so the default delivery is right for both `.task` and `.ask`.
 *
 * The agent is not passed: unlike V1, a session keeps its own agent (it is a
 * session property, changed with `switchAgent`), so a `.task` into a "yolo"
 * session stays in that mode.
 *
 * NOTE: unverified against a live session - delivery is the one V2 behaviour
 * this bridge does not exercise yet.
 */
async function prompt(sessionID: string, text: string): Promise<void> {
  await client().session.prompt({ sessionID, text });
}

const CONFIRM: Record<Verdict, string> = {
  once: "已批准 once",
  always: "已批准 always(记住)",
  reject: "已拒绝 reject",
};

/** Send to QQ, retrying a few times so a transient blip never drops it. */
async function sendWithRetry(content: string, attempts = 3): Promise<void> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await sendMarkdown(content);
      return;
    } catch (cause) {
      last = cause;
      await sleep(1000 * (i + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Drop pending entries the server no longer knows about.
 *
 * A permission can be answered in the TUI (or auto-allowed) at any time; the
 * `permission.replied` event covers the common case, but a request that resolved
 * before the bridge subscribed would linger first in the FIFO and make a later
 * QQ reply hit a dead request. Best-effort: on error the map is left untouched.
 */
/**
 * The request ids in whatever `permission.request.list` returned: V2 here answers
 * `{ location, data }`, but accept a bare array too rather than trust one shape.
 */
export function liveRequestIds(raw: unknown): Set<string> {
  const list = Array.isArray(raw) ? raw : ((raw as { data?: readonly unknown[] } | null)?.data ?? []);
  const ids = new Set<string>();
  for (const item of list) {
    const id = (item as { id?: unknown })?.id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

async function reconcilePending(): Promise<void> {
  if (!pending.size) return;
  // This endpoint takes a location and answers `{ location, data }`. Pruning is
  // deliberately conservative: only a NON-empty answer may mark a request dead.
  // (Treating an empty answer as "gone" turned every QQ approval into "expired".)
  for (const [id, p] of [...pending]) {
    const directory = await sessionDirectory(p.sessionID).catch(() => "");
    let live: Set<string>;
    try {
      live = liveRequestIds(await client().permission.request.list({ location: { directory } }));
    } catch {
      continue;
    }
    if (live.size > 0 && !live.has(id)) {
      pending.delete(id);
      log(`pruned stale permission ${id}`);
    }
  }
}

/**
 * Render a permission request for QQ.
 *
 * QQ markdown has no code-block rendering for the shapes we tried, but it does
 * render fenced blocks with a language (verified: ` ```sh ` gets a block+highlight).
 * A raw bash command dumped as one line is unreadable on a phone, so the command
 * goes into a fenced block.
 *
 * For external_directory the command is NOT the point - what you are granting is
 * the DIRECTORY. The plain `patterns` line tells you the exact scope that
 * "always" will remember, which a command cannot convey.
 *
 * Pure and exported so the layout is testable.
 */
export function formatPermission(
  directory: string,
  permission: string,
  metadata: Record<string, unknown>,
  patterns: string[],
  sessionNum?: number,
  aside = false,
): string {
  // A request out of nowhere is baffling, and an aside fork asking for approval
  // is exactly that: label it, and say where the fork lives.
  const header = aside
    ? "**需要授权 · 来自旁问**"
    : sessionNum !== undefined
      ? `**需要授权 · #${sessionNum}**`
      : "**需要授权**";
  const lines = [header, `目录: \`${directory}\``, `工具: **${permission}**`];
  if (aside) lines.push("（这是 `.bt` 旁问在问你：它跑在一个用完即弃的分支里，答完就删）");

  if (permission === "external_directory") {
    const dirs = Array.isArray(metadata.directories) ? metadata.directories.map(String) : [];
    const command = typeof metadata.command === "string" ? metadata.command : "";
    if (dirs.length) {
      lines.push("", "访问目录:");
      for (const d of dirs) lines.push(`- \`${d}\``);
    }
    if (patterns.length) {
      lines.push("", "记住(always)范围:");
      for (const p of patterns) lines.push(`- \`${p}\``);
    }
    if (command) lines.push("", "命令:", "```sh", command.trim(), "```");
  } else {
    const command =
      (typeof metadata.command === "string" && metadata.command) ||
      (typeof metadata.filePath === "string" && metadata.filePath) ||
      (typeof metadata.filepath === "string" && metadata.filepath) ||
      (patterns.length ? patterns.join(" ") : "(no detail)");
    lines.push("", "```sh", String(command).trim(), "```");
  }

  lines.push("", "回复  **.o**=once  **.a**=always(记住)  **.r**=reject（指名会话：`.o #2`）");
  return lines.join("\n");
}

/** The question text of a form: the first titled field, else the form's own title. */
export function questionOf(form: { title?: string; fields?: FormField[] } | undefined): string {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const first = fields.find((f) => typeof f.title === "string" && f.title);
  return first?.title ?? form?.title ?? "(无标题问题)";
}

/**
 * Map a typed reply onto the form's first field.
 *
 * Matching an option's value or label wins, so `.answer 生产` sends the value the
 * form expects; anything else is sent as free text. Only the first field is
 * answerable - the `question` tool builds single-question forms.
 */
export function buildAnswer(fields: FormField[], text: string): Record<string, string> | null {
  const field = fields.find((f) => typeof f.key === "string" && f.key);
  if (!field?.key) return null;
  const typed = text.trim();
  const wanted = typed.toLowerCase();
  const options = Array.isArray(field.options) ? field.options : [];
  const hit = options.find((o) => {
    const value = typeof o.value === "string" ? o.value.toLowerCase() : "";
    const label = typeof o.label === "string" ? o.label.toLowerCase() : "";
    return value === wanted || label === wanted;
  });
  return { [field.key]: hit && typeof hit.value === "string" ? hit.value : typed };
}

/** Render a waiting question for QQ. Pure, so the layout is testable. */
export function formatForm(
  directory: string,
  question: string,
  fields: FormField[],
  sessionNum?: number,
): string {
  const header = sessionNum !== undefined ? `**需要你回答 · #${sessionNum}**` : `**需要你回答**`;
  const lines = [header, `目录: \`${directory}\``, "", question];

  const first = fields.find((f) => typeof f.key === "string" && f.key);
  const options = Array.isArray(first?.options) ? first.options : [];
  if (options.length) {
    lines.push("");
    for (const o of options) {
      const label = (typeof o.label === "string" && o.label) || (typeof o.value === "string" && o.value) || "";
      lines.push(`- ${label}`);
    }
  }

  lines.push("", "回复  **.answer <你的答案>**（可写选项文字或自由文本）");
  return lines.join("\n");
}

/** Drop forms the server no longer lists (answered in the TUI, or cancelled). */
async function reconcileForms(sessionID: string): Promise<void> {
  const mine = [...pendingForms.values()].filter((f) => f.sessionID === sessionID);
  if (!mine.length) return;
  try {
    const live = new Set<string>((await client().session.form.list({ sessionID })).map((f) => String(f.id)));
    for (const f of mine) {
      if (!live.has(f.formID)) {
        pendingForms.delete(f.formID);
        log(`pruned stale form ${f.formID}`);
      }
    }
  } catch {
    /* keep the map on failure */
  }
}

async function handleOpencodeEvent(event: OpencodeEvent): Promise<void> {
  try {
    lastEventAt = Date.now();
    const type = event.type;
    const data = event.data ?? {};

    // Busy-ness is observed rather than asked for: a step starting means work is
    // in flight, and a step that ends without wanting a tool call means the turn
    // is over (V2 has no session.status / session.idle on the public stream).
    if (type === "session.step.started") {
      noteBusy(asString(data.sessionID), true);
      return;
    }
    if (type === "session.step.ended") {
      if (data.finish === "tool-calls") return;
      const ended = asString(data.sessionID);
      noteBusy(ended, false);
      // Release any .task held for this session now that its turn is over.
      if (ended) await drainQueue(ended);
      return;
    }

    // A permission resolved elsewhere (approved in the TUI, auto-allowed) must
    // leave the pending map, or a later QQ reply targets a dead request and 404s.
    if (type === "permission.replied") {
      const pid = asString(data.requestID);
      if (pid && pending.delete(pid)) {
        log(`permission ${pid} resolved elsewhere; dropped from pending`);
      }
      return;
    }

    // A question is the other thing that blocks the run, and the bridge is what
    // answers it (`.answer`), so it pushes it too - not gated by the away switch.
    if (type === "form.created") {
      const form = data.form as { id?: string; sessionID?: string; title?: string; fields?: FormField[] } | undefined;
      const formID = asString(form?.id);
      if (!formID || pendingForms.has(formID)) return;

      const sessionID = asString(form?.sessionID) ?? "";
      const fields = Array.isArray(form?.fields) ? form.fields : [];
      const question = questionOf(form);
      pendingForms.set(formID, { formID, sessionID, question, fields });
      if (sessionID) rememberSession(sessionID);

      // The push is the point, so the directory lookup must not throw past it.
      let directory = "(unknown)";
      try {
        if (sessionID) directory = await sessionDirectory(sessionID);
      } catch {
        /* keep "(unknown)" */
      }
      const num = sessionID ? rememberSession(sessionID) : undefined;
      await sendWithRetry(formatForm(directory, question, fields, num));
      log(`form ${formID} (${question.slice(0, 40)}) -> QQ`);
      return;
    }

    if (type === "form.replied" || type === "form.cancelled") {
      const fid = asString(data.id);
      if (fid && pendingForms.delete(fid)) {
        log(`form ${fid} resolved elsewhere; dropped from pending`);
      }
      return;
    }

    // Registry upkeep is best-effort: a transient server hiccup must never abort
    // event handling.
    await refreshSessionRegistry().catch(() => {});

    // Track the most recent session from ANY event, not just permissions:
    // `.stop` / `.task` need a target even when no permission has fired.
    const anySessionID = asString(data.sessionID);
    if (anySessionID) rememberSession(anySessionID);

    if (type !== "permission.asked") return;
    const requestID = asString(data.id);
    if (!requestID || pending.has(requestID)) return;

    const permission = typeof data.action === "string" ? data.action : "unknown";
    const patterns = Array.isArray(data.resources) ? data.resources.map(String) : [];
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;

    // The QQ push is the point, so the directory lookup must not be able to
    // throw past it (this is exactly how a subagent approval got dropped once).
    let directory = "(unknown)";
    try {
      if (anySessionID) directory = await sessionDirectory(anySessionID);
    } catch {
      /* keep "(unknown)" */
    }
    const num = anySessionID ? rememberSession(anySessionID) : undefined;
    const aside = anySessionID ? asideIds.has(anySessionID) || asideSeen.has(anySessionID) : false;

    pending.set(requestID, { requestID, sessionID: anySessionID ?? "", permission });
    await sendWithRetry(formatPermission(directory, permission, metadata, patterns, num, aside));
    log(`permission ${requestID} (${permission}) -> QQ`);
  } catch (cause) {
    log(`failed to handle permission: ${cause instanceof Error ? cause.message : cause}`);
  }
}

async function handleQqEvent(event: GatewayEvent): Promise<void> {
  try {
    if (event.t !== "C2C_MESSAGE_CREATE" && event.t !== "GROUP_AT_MESSAGE_CREATE") return;
    const content = (event.d as { content?: string } | undefined)?.content ?? "";

    // Commands (.task / .ask / .stop) are checked first: their
    // leading word makes them unambiguous against the o/a/r replies.
    const command = parseCommand(content);
    if (command) {
      await runCommand(command);
      return;
    }

    const wantFor = replyTarget(content);
    const reply = parseReply(content);
    if (!reply) return; // unrelated chatter; stay silent

    // Drop anything already resolved elsewhere before choosing the FIFO target.
    const before = pending.size;
    await reconcilePending();

    // "#N" answers that session's requests (a branch can have several in flight).
    // Without it, FIFO: with several waiting, "o" must mean one unambiguous one.
    const forSession = wantFor !== undefined ? sessionNumbers.resolve(wantFor) : undefined;
    const target = (forSession
      ? [...pending.values()].find((p) => p.sessionID === forSession)
      : pending.values().next().value) as Pending | undefined;
    if (!target) {
      if (before > 0) await sendText("待处理的审批都已失效（可能已在电脑上处理）");
      log(`reply "${content.trim()}" ignored: no live pending request`);
      return;
    }

    try {
      await client().permission.reply({
        sessionID: target.sessionID,
        requestID: target.requestID,
        decision: reply,
      });
    } catch (cause) {
      // A request answered elsewhere between the liveness check and the reply is
      // gone for good: say so instead of reporting a hard failure. Only a non-empty
      // answer that lacks the id proves it - an empty one proves nothing.
      const directory = await sessionDirectory(target.sessionID).catch(() => "");
      const list = await client()
        .permission.request.list({ location: { directory } })
        .catch(() => null);
      const live = list ? liveRequestIds(list) : null;
      const stillLive = live === null || live.size === 0 || live.has(target.requestID);
      if (stillLive) throw cause;
      pending.delete(target.requestID);
      await sendText(`该审批已失效（可能已在电脑上处理）· ${target.permission}`);
      log(`permission ${target.requestID} already resolved; reply skipped`);
      return;
    }

    pending.delete(target.requestID);
    const doneNum = sessionNumbers.lookup(target.sessionID);
    await sendText(`${CONFIRM[reply]} · ${target.permission}${doneNum !== undefined ? ` · #${doneNum}` : ""}`);
    log(`permission ${target.requestID} -> ${reply}`);
  } catch (cause) {
    log(`failed to handle QQ reply: ${cause instanceof Error ? cause.message : cause}`);
  }
}

// ---------------------------------------------------------------------------
// SSE subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to the service's event stream, reconnecting forever.
 *
 * A dropped stream is expected, not fatal. The service is re-discovered on every
 * attempt, because a restarted service comes back on a different port.
 */
async function subscribeEvents(
  onEvent: (event: OpencodeEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let backoff = 1000;
  let announced = false;
  while (!signal.aborted) {
    try {
      const connection = await connectClient();
      backoff = 1000;
      announced = false;
      log("subscribed to opencode events");

      for await (const event of connection.event.subscribe({ signal })) {
        onEvent(event as OpencodeEvent);
      }
      throw new Error("stream ended");
    } catch (cause) {
      if (signal.aborted) return;
      // Say it once, loudly: the usual cause is "no opencode service running",
      // which otherwise looks like the bridge doing nothing.
      if (!announced) {
        announced = true;
        log("cannot reach a local opencode service");
        log("(start opencode once, or run `opencode service restart`)");
      }
      log(`event stream dropped (${cause instanceof Error ? cause.message : cause}); retry in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function check(): Promise<number> {
  console.log(`config: ${configPath()}`);

  const cfg = loadConfig();
  if (!cfg.qqbot) {
    console.log("  qqbot: NOT configured (see README)");
    return 2;
  }
  console.log(`  qqbot.appId: ${cfg.qqbot.appId.slice(0, 6)}...`);
  console.log(`  qqbot.notifyTarget: ${cfg.qqbot.notifyTarget ? JSON.stringify(cfg.qqbot.notifyTarget) : "(not set)"}`);

  try {
    const token = await getAccessToken(true);
    console.log(`  token: OK (${token.slice(0, 8)}...)`);
  } catch (cause) {
    console.log(`  token: FAILED - ${cause instanceof Error ? cause.message : cause}`);
    return 1;
  }

  try {
    const endpoint = await Service.discover();
    if (!endpoint) throw new Error("no local service registered");
    const connection = await connectClient();
    const list = await connection.permission.request.list({});
    console.log(`  opencode service: OK (${endpoint.url}, ${list.data?.length ?? 0} pending)`);
  } catch (cause) {
    console.log(`  opencode service: FAILED - ${cause instanceof Error ? cause.message : cause}`);
    return 1;
  }
  return 0;
}

function help(): number {
  console.log(
    [
      "bridge - remote permission approval over QQ",
      "",
      "usage:",
      "  bun run src/bridge.ts            start the daemon",
      "  bun run src/bridge.ts --check    verify config + token + service",
      "  bun run src/bridge.ts --help",
      "",
      "The opencode service is discovered automatically (url + password);",
      "there is no fixed port and no manual `opencode serve` + attach.",
      "",
      "env:",
      "  OPENCODE_NOTIFY_QQ_LOCK_PORT   single-instance lock port (default 4097)",
    ].join("\n"),
  );
  return 0;
}

async function run(): Promise<number> {
  const cfg = loadConfig();
  if (!cfg.qqbot) {
    console.error("QQ bot not configured. Add a \"qqbot\" section (see README).");
    return 2;
  }

  // Single-instance guard. The QQ gateway allows only one WSS per appId+shard;
  // a second connection kicks the first (op 9). A bound TCP port is the lock:
  // the OS guarantees uniqueness and releases it when the process dies, so
  // there are no stale PID files to reason about.
  //
  // The listener type is written structurally (only `stop` is used) rather than
  // importing Bun's server type for one method.
  type BridgeServer = { stop(closeActiveConnections?: boolean): void };
  let server: BridgeServer | null = null;
  try {
    // The bound port is the single-instance lock (the OS releases it when the
    // process dies) and it doubles as the endpoint the TUI's `/bt` calls - the
    // aside logic lives here, so the plugin only has to ask.
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: LOCK_PORT,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/aside") {
          const body = (await req.json().catch(() => null)) as { sessionID?: string; question?: string } | null;
          if (!body?.sessionID || !body.question) {
            return Response.json({ error: "sessionID and question are required" }, { status: 400 });
          }
          // Detached: the answer lands in the session once it is ready.
          void runAsideTui(body.sessionID, body.question);
          return Response.json({ ok: true });
        }
        return new Response("opencode-notify-qq bridge\n");
      },
    });
  } catch {
    console.error(`another bridge is already running (port ${LOCK_PORT} is in use).`);
    console.error(`stop it first, or set OPENCODE_NOTIFY_QQ_LOCK_PORT to a free port.`);
    return 3;
  }
  writeState();

  const client = new QqBotClient({
    onLog: (m) => log(`gateway: ${m}`),
    onEvent: (e) => void handleQqEvent(e),
  });
  gateway = client;
  try {
    await client.connect();
  } catch (cause) {
    console.error(`failed to start: ${cause instanceof Error ? cause.message : cause}`);
    server.stop(true);
    return 1;
  }
  log(`QQ gateway connected (lock port ${LOCK_PORT})`);

  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    client.close();
    server?.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await subscribeEvents((e) => void handleOpencodeEvent(e), abort.signal);
  return 0;
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (arg === "--check") return check();
  if (arg === "--help" || arg === "-h") return help();
  if (arg) {
    console.error(`unknown option: ${arg} (try --help)`);
    return 2;
  }
  return run();
}

if (import.meta.main) {
  process.exit(await main());
}
