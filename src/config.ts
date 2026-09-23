/**
 * Configuration for QQ notifications.
 *
 * Secrets live outside every repo, in a single file:
 *
 *   ~/.config/opencode/notify-qq.json
 *   (Windows: C:\Users\<you>\.config\opencode\notify-qq.json)
 *
 * Override with the NOTIFY_QQ_CONFIG environment variable. The file is
 * optional; a missing or incomplete qqbot section means "not configured".
 *
 * Example:
 *   {
 *     "qqbot": {
 *       "appId": "102xxxxxx",
 *       "clientSecret": "your-client-secret",
 *       "sandbox": false,
 *       "notifyTarget": { "type": "c2c", "openid": "A1B2..." }
 *     }
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type NotifyTarget =
  | { type: "c2c"; openid: string }
  | { type: "group"; groupOpenid: string };

export type QqBotConfig = {
  appId: string;
  clientSecret: string;
  /** Sandbox bots use a separate API domain and separate credentials. */
  sandbox: boolean;
  /** Default destination for pushes. */
  notifyTarget?: NotifyTarget;
};

export type NotifyConfig = {
  qqbot?: QqBotConfig;
};

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "opencode", "notify-qq.json");
}

export function configPath(): string {
  const override = process.env.NOTIFY_QQ_CONFIG?.trim();
  if (override) return isAbsolute(override) ? override : resolve(override);
  return defaultConfigPath();
}

type Raw = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function parseTarget(v: unknown): NotifyTarget | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Raw;
  if (o.type === "c2c" && typeof o.openid === "string" && o.openid.trim())
    return { type: "c2c", openid: o.openid.trim() };
  if (o.type === "group" && typeof o.groupOpenid === "string" && o.groupOpenid.trim())
    return { type: "group", groupOpenid: o.groupOpenid.trim() };
  return undefined;
}

function parseQqBot(v: unknown): QqBotConfig | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Raw;
  const appId = asString(o.appId);
  const clientSecret = asString(o.clientSecret);
  if (!appId || !clientSecret) return undefined;
  const target = parseTarget(o.notifyTarget);
  return {
    appId,
    clientSecret,
    sandbox: o.sandbox === true,
    ...(target ? { notifyTarget: target } : {}),
  };
}

export function loadConfig(path = configPath()): NotifyConfig {
  let raw: Raw = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Raw;
    } catch (cause) {
      throw new Error(
        `invalid config at ${path}: ${cause instanceof Error ? cause.message : cause}`,
      );
    }
  }
  const qqbot = parseQqBot(raw.qqbot);
  return { ...(qqbot ? { qqbot } : {}) };
}
