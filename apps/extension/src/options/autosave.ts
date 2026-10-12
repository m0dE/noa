/**
 * The options page's save queue: saves run one after another, never at the
 * same time; schedule() lets typing settle first, flush() saves now (e.g.
 * before a test uses the settings on screen).
 */
export class SaveQueue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  /** save: saves whatever changed; false when it could not. */
  constructor(private readonly save: () => Promise<boolean>) {}

  /** Queue a save after `delayMs` (a later call restarts the wait). */
  schedule(delayMs = 0): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue();
    }, delayMs);
  }

  /** Save anything pending now; resolves with whether that save worked. */
  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.enqueue();
  }

  private enqueue(): Promise<boolean> {
    const run = this.chain.then(() => this.save());
    this.chain = run.catch(() => undefined);
    return run;
  }
}
