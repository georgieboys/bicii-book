/**
 * An in-process sliding one-minute window (per server instance, D88). The
 * webhook routes use it to cap how many rejected deliveries a minute they
 * store as evidence: Shopify's (src/lib/integrations/shopify/webhooks.ts)
 * and Stripe's (src/lib/integrations/stripe/webhooks.ts). Above the cap a
 * rejection is only logged. Pure, so the unit tests drive it with a fake
 * clock.
 */
export class SlidingWindowLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True (and counted) while fewer than `max` hits fall in the window. */
  allow(): boolean {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(t);
    return true;
  }
}
