/**
 * Delivery with retry.
 *
 * A notification exists so you learn about something while away. A transient
 * network blip ("Was there a typo in the url or port?") once dropped a whole
 * completion push silently, which defeats the point. So a failed send is
 * retried a couple of times before giving up.
 *
 * The sleep function is injected so the retry schedule is testable without
 * waiting in real time.
 */

export type DeliveryOutcome = {
  ok: boolean;
  /** How many send attempts were made (>= 1). */
  attempts: number;
  /** The last error message when ok is false. */
  error?: string;
};

/** Backoff between attempts, in ms. 2 entries => up to 3 attempts total. */
export const DEFAULT_DELAYS = [1000, 3000];

export async function deliverWithRetry(
  send: () => Promise<void>,
  sleep: (ms: number) => Promise<void>,
  delays: number[] = DEFAULT_DELAYS,
): Promise<DeliveryOutcome> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
    try {
      await send();
      return { ok: true, attempts: attempt };
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
      if (attempt <= delays.length) await sleep(delays[attempt - 1]!);
    }
  }
  return { ok: false, attempts: delays.length + 1, error: lastError };
}
