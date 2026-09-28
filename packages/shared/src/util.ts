/** Small helpers every package uses. Browser-, Worker- and Node-safe. */

/** A wait of `ms` milliseconds; injected as `sleep` where tests need to skip real time. */
export type Sleep = (ms: number) => Promise<void>;
export const delay: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The message of a thrown value, for logs, results and UI errors. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Collapse whitespace and lowercase, for loose text comparison. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Reads until `done` accepts the value: once right away, then every
 * intervalMs for up to timeoutMs. The wait is counted in intervals slept, so
 * an injected `sleep` keeps it deterministic. Returns the last value read and
 * whether `done` accepted it.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  opts: { intervalMs: number; timeoutMs: number; sleep?: Sleep },
): Promise<{ value: T; ok: boolean }> {
  const sleep = opts.sleep ?? delay;
  const polls = opts.intervalMs > 0 ? Math.ceil(opts.timeoutMs / opts.intervalMs) : 0;
  let value = await read();
  for (let i = 0; i < polls && !done(value); i++) {
    await sleep(opts.intervalMs);
    value = await read();
  }
  return { value, ok: done(value) };
}
