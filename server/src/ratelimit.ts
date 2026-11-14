/** In-memory token buckets keyed by (class, client). Good enough for a single-process service. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `perMinute` is the sustained refill rate; `burst` is the bucket size (defaults to one minute's worth, min 1). */
  allow(cls: string, client: string, perMinute: number, burst = Math.max(1, perMinute)): boolean {
    const key = `${cls}|${client}`;
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: burst, at: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 60_000) * perMinute);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return ok;
  }

  /** Drop idle buckets so memory stays bounded. */
  sweep(maxIdleMs = 10 * 60_000): void {
    const cutoff = this.now() - maxIdleMs;
    for (const [k, b] of this.buckets) if (b.at < cutoff) this.buckets.delete(k);
  }
}
