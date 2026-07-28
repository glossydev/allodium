/**
 * In-memory sliding-window rate limiter for auth endpoints.
 *
 * SINGLE-PROCESS ASSUMPTION: a process-local Map only sees this process's requests.
 * Counters reset on restart or deploy (fail-open) and are NOT shared across instances —
 * correct for the one-Next-process-per-box deployment shape; if you scale past one
 * instance, put a shared store (Postgres/Redis) behind the same signature.
 *
 * Callers pick their own key namespace (e.g. 'login:ip:1.2.3.4', 'pwreq:email:a@b.c')
 * and limits; the limiter itself is policy-free.
 */

interface Bucket {
  /** Window the key was last checked with — used by the sweeper to expire the bucket. */
  windowMs: number;
  /** Timestamps (ms) of recorded hits, oldest first. */
  times: number[];
}

export type RateLimiter = (key: string, max: number, windowMs: number) => boolean;

/**
 * Create a limiter. The returned function is a sliding-window check: it returns true
 * and RECORDS the hit when `key` has had fewer than `max` recorded hits in the trailing
 * `windowMs`; it returns false (nothing recorded) when the key is over the limit — so a
 * hammering client still gets at most `max` accepted attempts per window, and backing
 * off actually helps.
 */
export function createRateLimiter(opts: { sweepIntervalMs?: number } = {}): RateLimiter {
  const sweepIntervalMs = opts.sweepIntervalMs ?? 5 * 60_000;
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  /** Opportunistic prune: drop buckets whose newest hit fell out of their own window. */
  function sweep(now: number): void {
    if (now - lastSweep < sweepIntervalMs) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      const newest = bucket.times[bucket.times.length - 1];
      if (newest === undefined || newest <= now - bucket.windowMs) buckets.delete(key);
    }
  }

  return function limit(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    sweep(now);

    const cutoff = now - windowMs;
    const times = (buckets.get(key)?.times ?? []).filter((t) => t > cutoff);

    if (times.length >= max) {
      buckets.set(key, { windowMs, times });
      return false;
    }

    times.push(now);
    buckets.set(key, { windowMs, times });
    return true;
  };
}
