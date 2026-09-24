/**
 * Stable short numbers for sessions.
 *
 * A session id is a long opaque string (e.g. ses_f32fea229ffei4uHDu8vDoIOV8),
 * which is impossible to type from a phone. This maps each session to a small
 * integer (1, 2, 3...) so a reply can name one: `.stop 2`, `.task 1 do X`.
 *
 * Numbers are assigned on first sight and never reused or reshuffled, so a
 * number you saw in a notification keeps pointing at the same session for the
 * lifetime of the bridge.
 */
export class SessionNumbers {
  #byId = new Map<string, number>();
  #byNum = new Map<number, string>();

  /** The stable number for a session, assigning the next one on first sight. */
  numberFor(id: string): number {
    const existing = this.#byId.get(id);
    if (existing !== undefined) return existing;
    const n = this.#byNum.size + 1;
    this.#byId.set(id, n);
    this.#byNum.set(n, id);
    return n;
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
