/**
 * Stable short numbers for sessions.
 *
 * A session id is a long opaque string (e.g. ses_f32fea229ffei4uHDu8vDoIOV8),
 * which is impossible to type from a phone. This maps each session to a small
 * integer (1, 2, 3...) so a reply can name one: `.stop #2`, `.task #1 do X`.
 *
 * Numbers are stable: the same id always yields the same number, and a number
 * is never reused. They are also persisted, because two processes show them -
 * the bridge owns permission notices, the plugin owns completion notices - and
 * both must agree. The bridge allocates and writes; the plugin only reads.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { configPath } from "./config";

/** Where the shared number map lives (next to the QQ config). */
export function sessionNumbersPath(): string {
  return (
    process.env.OPENCODE_NOTIFY_QQ_NUMBERS ||
    join(dirname(configPath()), "session-numbers.json")
  );
}

type Persisted = { byId?: Record<string, number> };

export class SessionNumbers {
  #byId = new Map<string, number>();
  #byNum = new Map<number, string>();
  #path: string | undefined;

  constructor(path?: string) {
    this.#path = path;
    if (path) this.#load();
  }

  #load(): void {
    if (!this.#path) return;
    try {
      const data = JSON.parse(readFileSync(this.#path, "utf8")) as Persisted;
      for (const [id, n] of Object.entries(data.byId ?? {})) {
        if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) continue;
        this.#byId.set(id, n);
        this.#byNum.set(n, id);
      }
    } catch {
      /* first run, or unreadable: start empty */
    }
  }

  #save(): void {
    if (!this.#path) return;
    try {
      writeFileSync(this.#path, JSON.stringify({ byId: Object.fromEntries(this.#byId) }), "utf8");
    } catch {
      /* persistence is best-effort; numbering still works in-process */
    }
  }

  /** The stable number for a session, assigning and persisting on first sight. */
  numberFor(id: string): number {
    const existing = this.#byId.get(id);
    if (existing !== undefined) return existing;
    // Next free number is max+1, not size+1: loaded maps can have gaps.
    let max = 0;
    for (const n of this.#byNum.keys()) if (n > max) max = n;
    const n = max + 1;
    this.#byId.set(id, n);
    this.#byNum.set(n, id);
    this.#save();
    return n;
  }

  /** Read-only lookup; never allocates. */
  lookup(id: string): number | undefined {
    return this.#byId.get(id);
  }

  /** Resolve a number back to a session id, or undefined if unknown. */
  resolve(n: number): string | undefined {
    return this.#byNum.get(n);
  }

  /** Known sessions as [number, id] pairs, ascending. */
  entries(): Array<[number, string]> {
    return [...this.#byNum.entries()].sort((a, b) => a[0] - b[0]);
  }
}

/** Load the persisted map (read-only use: the plugin shows, it does not allocate). */
export function readSessionNumbers(path = sessionNumbersPath()): SessionNumbers {
  return new SessionNumbers(path);
}
