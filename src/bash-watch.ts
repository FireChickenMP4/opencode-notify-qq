/**
 * Watchdog for long-running bash commands.
 *
 * opencode's own bash tool caps at 120s (default) / 600s (max), so a command
 * that hangs is eventually killed - but while you are away nothing tells you it
 * is stuck. `retry` notifications do NOT cover this: that status is about the
 * model API, not the shell.
 *
 * Detection needs a timer, not event counting: a blocked command (a server, a
 * stdin wait) emits no further `message.part.updated`, so "has it run too long"
 * can only be answered by a clock started when it went running.
 *
 * Timers are injected so the decision logic is testable without real time.
 */

export type BashObservation = {
  callID: string;
  /** Tool state: "pending" | "running" | "completed" | "error". */
  status: string;
  /** Epoch ms the command started (from state.time.start). */
  startMs?: number;
};

export type Scheduler = {
  schedule(ms: number, fn: () => void): unknown;
  cancel(handle: unknown): void;
};

export class BashWatch {
  #timers = new Map<string, unknown>();
  #alerted = new Set<string>();

  constructor(
    private readonly thresholdMs: number,
    private readonly scheduler: Scheduler,
    private readonly onLong: (o: { callID: string; startMs: number }) => void,
  ) {}

  /**
   * Feed one tool-part observation.
   *
   * A `running` observation arms a timer (once per call). Any terminal status
   * disarms it. If the timer fires, `onLong` is called - at most once per call.
   */
  observe(o: BashObservation): void {
    if (o.status === "running") {
      if (this.#timers.has(o.callID) || this.#alerted.has(o.callID)) return;
      const startMs = o.startMs ?? Date.now();
      const handle = this.scheduler.schedule(this.thresholdMs, () => {
        this.#timers.delete(o.callID);
        this.#alerted.add(o.callID);
        this.onLong({ callID: o.callID, startMs });
      });
      this.#timers.set(o.callID, handle);
      return;
    }
    // pending / completed / error: not (or no longer) running.
    const handle = this.#timers.get(o.callID);
    if (handle !== undefined) {
      this.scheduler.cancel(handle);
      this.#timers.delete(o.callID);
    }
    if (o.status === "completed" || o.status === "error") this.#alerted.delete(o.callID);
  }

  /** Number of commands currently armed (diagnostics / tests). */
  pending(): number {
    return this.#timers.size;
  }
}

/** One-line alert body for a command that has run too long. */
export function bashAlert(command: string, elapsedMs: number): string {
  const secs = Math.round(elapsedMs / 1000);
  const flat = command.replace(/\s+/g, " ").trim();
  const shown = flat.length > 160 ? `${flat.slice(0, 160)}...` : flat;
  return `**opencode · 命令运行中**\n\n已运行约 ${secs}s，可能卡住了\n\n\`\`\`sh\n${shown}\n\`\`\``;
}
