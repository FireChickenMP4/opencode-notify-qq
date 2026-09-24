/**
 * Short numbers for sessions.
 *
 * A session id is a long opaque string (e.g. ses_f32fea229ffei4uHDu8vDoIOV8),
 * which is impossible to type from a phone. This maps each session to a small
 * integer (1, 2, 3...) so a reply can name one: `.stop #2`, `.task #1 do X`.
 *
 * A number is stable while its session stays live, and the smallest free number
 * is reused once a session is pruned - so numbers stay small instead of
 * climbing forever. They are persisted because two processes show them: the
 * bridge owns permission notices, the plugin owns completion notices. The
 * bridge allocates and prunes; the plugin only reads.
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

  /**
   * The stable number for a session, assigning and persisting on first sight.
   *
   * Reuses the smallest free number rather than max+1, so numbers stay small
   * instead of drifting up forever. Stability holds while the session is live;
   * once prune() drops it, its number can be handed to another session.
   */
  numberFor(id: string): number {
    const existing = this.#byId.get(id);
    if (existing !== undefined) return existing;
    // Smallest positive integer not currently in use.
    let n = 1;
    while (this.#byNum.has(n)) n++;
    this.#byId.set(id, n);
    this.#byNum.set(n, id);
    this.#save();
    return n;
  }

  /**
   * Drop numbers for sessions that are no longer live, freeing their slots.
   *
   * Without this the map only grows: every session that ever emitted an event
   * would hold a number forever. The bridge passes the ids of currently live
   * main sessions; anything else is released.
   */
  prune(liveIds: Set<string>): void {
    let changed = false;
    for (const [n, id] of [...this.#byNum]) {
      if (liveIds.has(id)) continue;
      this.#byNum.delete(n);
      this.#byId.delete(id);
      changed = true;
    }
    if (changed) this.#save();
  }

  /** Read-only lookup; never allocates. */
  lookup(id: string): number | undefined {
    return this.#byId.get(id);
  }

  /** Resolve a number back to a session id, or undefined if unknown. */
  resolve(n: number): string | undefined {
    return this.#byNum.get(n);
  }
}

/** Load the persisted map (read-only use: the plugin shows, it does not allocate). */
export function readSessionNumbers(path = sessionNumbersPath()): SessionNumbers {
  return new SessionNumbers(path);
}
