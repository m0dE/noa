/** Change listeners. A listener that throws never breaks the one that notifies, nor the other listeners. */
export class Listeners<A extends unknown[] = []> {
  private readonly fns = new Set<(...args: A) => void>();

  /** Adds a listener; returns the function that removes it. */
  add(fn: (...args: A) => void): () => void {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  }

  emit(...args: A): void {
    for (const fn of [...this.fns]) callSafely(fn, ...args);
  }
}

/** Calls a listener (when there is one), ignoring what it throws: it is the listener's problem. */
export function callSafely<A extends unknown[]>(fn: ((...args: A) => unknown) | undefined, ...args: A): void {
  try {
    fn?.(...args);
  } catch {
    /* the listener's own problem */
  }
}
