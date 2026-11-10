/**
 * Client-side rate limiter for the STT API (Groq free tier: 20 requests/min per model).
 *
 * Why it exists: every utterance of every listened user becomes one HTTP request.
 * With several people talking, requests arrive in bursts. Without a limiter they
 * are all sent at once, Groq answers HTTP 429, and every failed request sleeps ~3 s
 * and retries at the same moment (a "thundering herd") — so most fail again and
 * are thrown away, and the retries eat the quota that is left.
 *
 * This limiter
 *   1. spaces requests so we stay under the quota (sliding window),
 *   2. serves them in arrival order (FIFO),
 *   3. gives up on a request that would have to wait too long — a voice command
 *      executed 30 s late is worse than one that is dropped,
 *   4. lets the caller pause everybody when the server says "try again in Xs".
 */

export class SttQueueTimeoutError extends Error {
  constructor(
    public readonly waitedMs: number,
    public readonly maxWaitMs: number,
    public readonly reason?: string,
  ) {
    super(
      `[stt-groq] rate-limit queue: would wait ${(waitedMs / 1000).toFixed(1)}s ` +
        `(max ${(maxWaitMs / 1000).toFixed(1)}s)${reason ? ` — ${reason}` : ""}`,
    );
    this.name = "SttQueueTimeoutError";
  }
}

export interface LimiterOptions {
  /** Requests allowed per window. Infinity = no limit. */
  maxPerWindow: number;
  /** Window length in ms (default 60 000). */
  windowMs?: number;
  /** Injectable clock / sleep (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class SlidingWindowLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Timestamps of the requests granted inside the current window (ascending). */
  private stamps: number[] = [];
  private pausedUntil = 0;
  private pauseReason: string | undefined;
  /** Requests currently waiting for (or just being granted) a slot. */
  private pending = 0;
  /** Promise chain that keeps waiters in FIFO order. Never rejects. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: LimiterOptions) {
    this.max = opts.maxPerWindow >= 1 ? Math.floor(opts.maxPerWindow) : 1;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private prune(t: number): void {
    while (this.stamps.length > 0 && t - this.stamps[0]! >= this.windowMs) {
      this.stamps.shift();
    }
  }

  /** ms a request that has `ahead` others in front of it must wait. 0 = go now. */
  private waitFor(ahead: number, t: number): number {
    this.prune(t);
    const paused = Math.max(0, this.pausedUntil - t);
    const free = Math.max(0, this.max - this.stamps.length);
    let window = 0;
    if (ahead >= free) {
      // The slot it needs is released when the (ahead - free)-th oldest stamp expires.
      const k = ahead - free;
      window =
        k < this.stamps.length ? this.stamps[k]! + this.windowMs - t : this.windowMs;
    }
    return Math.max(paused, window);
  }

  /** Rough wait for a NEW request, counting the ones already queued. 0 = goes out immediately. */
  estimateWaitMs(): number {
    return this.waitFor(this.pending, this.now());
  }

  /**
   * Block every request (queued and future) for `ms` — call this when the server
   * answered 429 with a "try again in" hint. A longer pause is never shortened.
   */
  pause(ms: number, reason?: string): void {
    const until = this.now() + Math.max(0, ms);
    if (until > this.pausedUntil) {
      this.pausedUntil = until;
      this.pauseReason = reason;
    }
  }

  private reasonIfPaused(t: number): string | undefined {
    return t < this.pausedUntil ? this.pauseReason : undefined;
  }

  /**
   * Wait for a free slot (FIFO). Rejects with SttQueueTimeoutError when getting one
   * would take longer than `maxWaitMs` in total — the caller should drop the request.
   */
  acquire(maxWaitMs: number): Promise<void> {
    const enqueuedAt = this.now();
    this.pending++; // synchronously, so estimateWaitMs() sees us immediately
    const run = async (): Promise<void> => {
      try {
        for (;;) {
          const t = this.now();
          const waited = t - enqueuedAt;
          // Stale already (e.g. it sat behind slower requests): don't take a slot.
          if (waited > maxWaitMs) {
            throw new SttQueueTimeoutError(waited, maxWaitMs, this.reasonIfPaused(t));
          }
          const wait = this.waitFor(0, t);
          if (wait <= 0) {
            this.stamps.push(t);
            return;
          }
          if (waited + wait > maxWaitMs) {
            throw new SttQueueTimeoutError(waited + wait, maxWaitMs, this.reasonIfPaused(t));
          }
          await this.sleep(wait);
        }
      } finally {
        this.pending--;
      }
    };
    const p = this.tail.then(run);
    this.tail = p.catch(() => {});
    return p;
  }
}
