/**
 * The publisher's view of who is watching (ADR-0225 §7, "freshness").
 *
 * A subscription is a lease: a visible consumer renews it, a hidden one ends
 * it, and one that disappears without saying so (a crashed or reloaded
 * webview) lapses after the TTL. The publisher computes slices only while at
 * least one lease is live and visible, so a closed panel costs nothing.
 */

export interface GlanceLease {
  consumer: string
  windowLabel: string
  expiresAt: number
}

export class GlanceSubscriptionRegistry {
  private readonly leases = new Map<string, GlanceLease>()

  constructor(private readonly ttlMs: number) {}

  /**
   * Record an announcement. Returns true when the set of live consumers
   * changed, which is when the publisher should push a snapshot right away.
   */
  announce(
    subscription: { consumer: string; windowLabel: string; visible: boolean },
    now: number
  ): boolean {
    const existing = this.leases.get(subscription.consumer)
    const wasLive = existing !== undefined && existing.expiresAt > now
    if (!subscription.visible) {
      this.leases.delete(subscription.consumer)
      return wasLive
    }
    this.leases.set(subscription.consumer, {
      consumer: subscription.consumer,
      windowLabel: subscription.windowLabel,
      expiresAt: now + this.ttlMs,
    })
    return !wasLive || existing?.windowLabel !== subscription.windowLabel
  }

  /** Drop lapsed leases. Returns true when any were dropped. */
  prune(now: number): boolean {
    let dropped = false
    for (const [consumer, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(consumer)
        dropped = true
      }
    }
    return dropped
  }

  /** Live leases at `now`. */
  live(now: number): GlanceLease[] {
    return [...this.leases.values()].filter((lease) => lease.expiresAt > now)
  }

  /** The window a consumer's results go to, while its lease is live. */
  windowOf(consumer: string, now: number): string | null {
    const lease = this.leases.get(consumer)
    return lease && lease.expiresAt > now ? lease.windowLabel : null
  }

  hasLive(now: number): boolean {
    return this.live(now).length > 0
  }
}
