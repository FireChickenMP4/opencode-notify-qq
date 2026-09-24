/**
 * QQ 官方机器人客户端（纯手写，无第三方依赖）。
 *
 * 只实现本项目需要的部分：
 *   - 取 AppAccessToken（带缓存与提前刷新）
 *   - 建立 WSS 网关长连接（Identify / Heartbeat / Resume）
 *   - 发送单聊(C2C)/群聊文字消息
 *
 * 凭据来自配置层（prototype/config.ts），不写死在代码里。
 *
 * 官方文档：
 *   获取凭证  https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 *   WSS 网关  https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html
 */

import { loadConfig, type QqBotConfig, type NotifyTarget } from "./config";

const TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken";

/**
 * OpenAPI host. Sandbox bots use a separate domain; production and sandbox
 * credentials are not interchangeable.
 */
function apiBase(sandbox: boolean): string {
  return sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com";
}

/** 群聊/单聊消息事件需要的 intents 位（GROUP_AND_C2C_EVENT = 1 << 25）。 */
export const INTENT_GROUP_AND_C2C = 1 << 25;

type TokenCache = { token: string; expiresAt: number };
let tokenCache: TokenCache | null = null;

export class QqBotError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "QqBotError";
    this.code = code;
  }
}

function requireConfig(): QqBotConfig {
  const cfg = loadConfig().qqbot;
  if (!cfg) {
    throw new QqBotError(
      "QQ bot not configured. Add an \"qqbot\" section to " +
        "~/.config/opencode/workflow.json (see README).",
    );
  }
  return cfg;
}

/**
 * 获取 AppAccessToken。有效期内复用；过期前 60s 自动刷新。
 * 注意：官方失败时 HTTP 仍返回 200，必须读 body.code。
 */
export async function getAccessToken(force = false): Promise<string> {
  const cfg = requireConfig();
  const now = Date.now();
  if (!force && tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.clientSecret }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: string | number;
    code?: number;
    message?: string;
  };

  if (!res.ok || body.code || !body.access_token) {
    throw new QqBotError(
      `failed to get access token: ${body.message ?? `HTTP ${res.status}`}`,
      body.code,
    );
  }

  const expiresIn = Number(body.expires_in ?? 7200);
  tokenCache = { token: body.access_token, expiresAt: now + expiresIn * 1000 };
  return tokenCache.token;
}

/** 清掉缓存，用于强制重新鉴权。 */
export function resetToken(): void {
  tokenCache = null;
}

// ---------------------------------------------------------------------------
// 发送消息
// ---------------------------------------------------------------------------

type SendResult = { id?: string; timestamp?: number };

function targetPath(target: NotifyTarget): string {
  return target.type === "c2c"
    ? `/v2/users/${target.openid}/messages`
    : `/v2/groups/${target.groupOpenid}/messages`;
}

/**
 * 发送文字消息。需要 notifyTarget 已配置。
 *
 * @param content - 纯文本。官方要求主动消息带 msg_seq 以去重。
 * @param msgId - 被动回复时传入收到的消息 id；主动推送可不传。
 */
export async function sendText(
  content: string,
  options: { target?: NotifyTarget; msgId?: string; msgSeq?: number } = {},
): Promise<SendResult> {
  const cfg = requireConfig();
  const target = options.target ?? cfg.notifyTarget;
  if (!target) {
    throw new QqBotError("no notifyTarget configured (c2c.openid or group.groupOpenid)");
  }

  const token = await getAccessToken();
  const res = await fetch(`${apiBase(cfg.sandbox)}${targetPath(target)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `QQBot ${token}`,
    },
    body: JSON.stringify({
      content,
      msg_type: 0,
      ...(options.msgId ? { msg_id: options.msgId } : {}),
      msg_seq: options.msgSeq ?? 1,
    }),
  });

  const body = (await res.json()) as SendResult & { code?: number; message?: string };
  if (!res.ok || body.code) {
    throw new QqBotError(
      `failed to send message: ${body.message ?? `HTTP ${res.status}`}`,
      body.code,
    );
  }
  return body;
}

/**
 * Send a markdown message (msg_type 2).
 *
 * Custom markdown is available to every bot in c2c and group chats since
 * 2026/04/23, no template approval needed. Supported: headings, bold, italic,
 * strikethrough, links, ordered/unordered lists, blockquote, hr.
 * Falls back to plain text on failure so a notification is never lost to
 * formatting.
 */
export async function sendMarkdown(
  content: string,
  options: { target?: NotifyTarget; msgId?: string; msgSeq?: number } = {},
): Promise<SendResult> {
  const cfg = requireConfig();
  const target = options.target ?? cfg.notifyTarget;
  if (!target) {
    throw new QqBotError("no notifyTarget configured (c2c.openid or group.groupOpenid)");
  }

  try {
    const token = await getAccessToken();
    const res = await fetch(`${apiBase(cfg.sandbox)}${targetPath(target)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `QQBot ${token}`,
      },
      body: JSON.stringify({
        markdown: { content },
        msg_type: 2,
        ...(options.msgId ? { msg_id: options.msgId } : {}),
        msg_seq: options.msgSeq ?? 1,
      }),
    });
    const body = (await res.json()) as SendResult & { code?: number; message?: string };
    if (res.ok && !body.code) return body;
    throw new QqBotError(body.message ?? `HTTP ${res.status}`, body.code);
  } catch {
    // Strip markdown syntax and re-send as plain text.
    return sendText(content.replace(/\*\*|__|[*_~`#]/g, "").replace(/\n{3,}/g, "\n\n"), options);
  }
}

// ---------------------------------------------------------------------------
// WSS 长连接
// ---------------------------------------------------------------------------

export type GatewayEvent = {
  op: number;
  s?: number;
  t?: string;
  d?: unknown;
  id?: string;
};

export type QqBotClientOptions = {
  intents?: number;
  /** 事件回调；抛错不会断开连接。 */
  onEvent?: (event: GatewayEvent) => void;
  onLog?: (message: string) => void;
  /** 断线自动重连（默认 true）。 */
  autoReconnect?: boolean;
};

/**
 * 一个最小可用的 QQ 官方机器人网关连接。
 *
 * 生命周期：connect -> Hello(op10) -> Identify(op2) -> Ready -> Heartbeat(op1)
 * 断线后若持有 session_id，走 Resume(op6) 补发遗漏事件。
 *
 * 这是"连接自己的机器人"，符合官方协议；官方限制连接数与频率，不要高频重连。
 */
export class QqBotClient {
  #ws: WebSocket | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #sessionId: string | null = null;
  #lastSeq: number | null = null;
  #closed = false;
  readonly #options: QqBotClientOptions;

  constructor(options: QqBotClientOptions = {}) {
    this.#options = options;
  }

  #log(message: string): void {
    this.#options.onLog?.(message);
  }

  /** 取网关地址（通用 WSS 接入点）。 */
  async #getGatewayUrl(): Promise<string> {
    const cfg = requireConfig();
    const token = await getAccessToken();
    const res = await fetch(`${apiBase(cfg.sandbox)}/gateway`, {
      headers: { authorization: `QQBot ${token}` },
    });
    const body = (await res.json()) as { url?: string; code?: number; message?: string };
    if (!res.ok || body.code || !body.url) {
      throw new QqBotError(
        `failed to get gateway: ${body.message ?? `HTTP ${res.status}`}`,
        body.code,
      );
    }
    return body.url;
  }

  /** 建立连接并完成鉴权。返回一个在首次 Ready 前完成的 Promise。 */
  async connect(): Promise<void> {
    const url = await this.#getGatewayUrl();
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.#ws = ws;
      let resolved = false;

      ws.addEventListener("open", () => this.#log("gateway connected"));
      ws.addEventListener("message", (ev) => {
        void this.#handleMessage(String((ev as MessageEvent).data), () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        });
      });
      ws.addEventListener("error", (ev) => {
        const detail = (ev as ErrorEvent).message ?? "unknown";
        this.#log(`gateway error: ${detail}`);
        if (!resolved) {
          resolved = true;
          reject(new QqBotError(`websocket error: ${detail}`));
        }
      });
      ws.addEventListener("close", (ev) => {
        this.#log(`gateway closed (code=${(ev as CloseEvent).code})`);
        this.#clearHeartbeat();
        if (!this.#closed && this.#options.autoReconnect !== false) {
          setTimeout(() => void this.connect().catch((e) => this.#log(`reconnect failed: ${e}`)), 3000);
        }
      });
    });
  }

  async #handleMessage(raw: string, onReady: () => void): Promise<void> {
    let event: GatewayEvent;
    try {
      event = JSON.parse(raw) as GatewayEvent;
    } catch {
      this.#log("dropped unparseable gateway frame");
      return;
    }

    if (typeof event.s === "number") this.#lastSeq = event.s;

    switch (event.op) {
      case 10: {
        // Hello: 带心跳周期，随后鉴权
        const interval = (event.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 45_000;
        await this.#identify();
        this.#startHeartbeat(interval);
        break;
      }
      case 11:
        break; // Heartbeat ACK
      case 0:
        if (event.t === "READY") {
          const d = event.d as { session_id?: string };
          this.#sessionId = d?.session_id ?? null;
          this.#log(`ready (session=${this.#sessionId?.slice(0, 8) ?? "?"})`);
          onReady();
        } else if (event.t === "RESUMED") {
          this.#log("session resumed");
          onReady();
        }
        this.#options.onEvent?.(event);
        break;
      case 7:
        this.#log("server requested reconnect");
        this.#ws?.close();
        break;
      case 9:
        this.#log("invalid session; clearing session state");
        this.#sessionId = null;
        this.#lastSeq = null;
        break;
      default:
        break;
    }
  }

  async #identify(): Promise<void> {
    const token = await getAccessToken();
    const intents = this.#options.intents ?? INTENT_GROUP_AND_C2C;
    if (this.#sessionId && this.#lastSeq !== null) {
      this.#send({ op: 6, d: { token: `QQBot ${token}`, session_id: this.#sessionId, seq: this.#lastSeq } });
    } else {
      this.#send({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents,
          shard: [0, 1],
          properties: { $os: process.platform, $browser: "workflow", $device: "workflow" },
        },
      });
    }
  }

  #startHeartbeat(intervalMs: number): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      this.#send({ op: 1, d: this.#lastSeq });
    }, intervalMs);
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #send(payload: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(payload));
    }
  }

  /** 主动关闭，不再自动重连。 */
  close(): void {
    this.#closed = true;
    this.#clearHeartbeat();
    this.#ws?.close();
    this.#ws = null;
  }
}

/**
 * 监听机器人事件（前台运行）。收到消息时可回调处理。
 * 这是一个长驻连接——不要在 agent 工具调用里同步等待它。
 */
export async function listen(
  onEvent: (event: GatewayEvent) => void,
  options: QqBotClientOptions = {},
): Promise<QqBotClient> {
  const client = new QqBotClient({ ...options, onEvent });
  await client.connect();
  return client;
}
