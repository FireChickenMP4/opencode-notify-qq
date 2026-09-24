/**
 * A per-session FIFO for messages held until the running turn ends.
 *
 * opencode has no working "deliver after this turn" route (`prompt_async` always
 * steers; the v2 delivery flag is a no-op), so `.task` is queued here and
 * released on idle. One item is released per idle: sending starts a new turn, so
 * a burst stays in order instead of merging.
 */
export class TaskQueue {
  #bySession = new Map<string, string[]>();

  /** Hold a message for a session. Returns the new queue length. */
  push(sessionID: string, text: string): number {
    const list = this.#bySession.get(sessionID) ?? [];
    list.push(text);
    this.#bySession.set(sessionID, list);
    return list.length;
  }

  /** The next message without removing it, or undefined. */
  peek(sessionID: string): string | undefined {
    return this.#bySession.get(sessionID)?.[0];
  }

  /** Remove and return the next message, or undefined. */
  shift(sessionID: string): string | undefined {
    const list = this.#bySession.get(sessionID);
    if (!list?.length) return undefined;
    const text = list.shift()!;
    if (list.length) this.#bySession.set(sessionID, list);
    else this.#bySession.delete(sessionID);
    return text;
  }

  /** How many messages a session has waiting. */
  size(sessionID: string): number {
    return this.#bySession.get(sessionID)?.length ?? 0;
  }
}
