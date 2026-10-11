/**
 * The desktop's side of glance for paired phones (ADR-0225 §7, §9): who is
 * watching, what they want, and the newest snapshot built for them.
 *
 * Two halves meet here and nowhere else. The companion dispatcher
 * (`host-dispatch.ts`, reached from `lib/companion/desktop-write-source.ts`)
 * records leases and asks for work; `GlancePublisherInitializer`, the only
 * code that can build a snapshot (its sources are React hooks in the main
 * window), reads the merged demand, builds for it, publishes the result on
 * `glance://update`, and installs the executor requests run through. Neither
 * imports the other.
 *
 * Leases work like the tray panel's: a visible phone renews, a hidden one
 * ends its lease, one that disappears lapses after the TTL, and with no live
 * lease nothing is built for phones at all.
 */

import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"

import { mergeGlanceDemands, type GlanceRemoteDemand } from "./types"

export interface GlanceRemoteLease {
  consumer: string
  demand: GlanceRemoteDemand
  /**
   * When this lease's demand last CHANGED, not when it was last renewed. The
   * merged options follow the most recent change, so two phones with
   * different choices do not swap the build back and forth on every renewal.
   */
  announcedAt: number
  expiresAt: number
}

/** What the publisher runs a phone's request through. Resolves to an `errors.*` key or null. */
export interface GlanceRemoteExecutor {
  refresh: () => Promise<string | null>
  quotaRefresh: (key: string) => Promise<string | null>
  quotaEnable: (provider: string, accountId: string) => Promise<string | null>
}

export class GlanceRemoteHub {
  private readonly leases = new Map<string, GlanceRemoteLease>()
  private readonly listeners = new Set<() => void>()
  private latest: GlanceSnapshotV1 | null = null
  private executor: GlanceRemoteExecutor | null = null
  private demandKey = ""

  constructor(private readonly ttlMs: number) {}

  get leaseTtlMs(): number {
    return this.ttlMs
  }

  /**
   * Record an announcement. Returns true when the merged demand changed,
   * which is when the publisher has to rebuild.
   */
  announce(
    lease: { consumer: string; visible: boolean; demand: GlanceRemoteDemand },
    now: number
  ): boolean {
    if (lease.visible) {
      const existing = this.leases.get(lease.consumer)
      const same =
        existing !== undefined &&
        existing.expiresAt > now &&
        JSON.stringify(existing.demand) === JSON.stringify(lease.demand)
      this.leases.set(lease.consumer, {
        consumer: lease.consumer,
        demand: lease.demand,
        announcedAt: same ? existing.announcedAt : now,
        expiresAt: now + this.ttlMs,
      })
    } else {
      this.leases.delete(lease.consumer)
    }
    return this.recompute(now)
  }

  /** Drop lapsed leases. Returns true when the merged demand changed. */
  prune(now: number): boolean {
    let dropped = false
    for (const [consumer, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(consumer)
        dropped = true
      }
    }
    return dropped ? this.recompute(now) : false
  }

  hasLive(now: number): boolean {
    for (const lease of this.leases.values()) if (lease.expiresAt > now) return true
    return false
  }

  /** The merged demand of the live leases, or null with none. */
  demand(now: number): GlanceRemoteDemand | null {
    return mergeGlanceDemands([...this.leases.values()].filter((lease) => lease.expiresAt > now))
  }

  /**
   * A stable string for the merged demand, for `useSyncExternalStore`: equal
   * strings mean the publisher has nothing new to build for. Empty with no
   * live lease.
   */
  getDemandKey = (): string => this.demandKey

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The publisher stores each snapshot it built for phones; null when it stops building. */
  setLatest(snapshot: GlanceSnapshotV1 | null): void {
    this.latest = snapshot
  }

  /** The newest snapshot, while some lease is live. */
  getLatest(now: number): GlanceSnapshotV1 | null {
    return this.hasLive(now) ? this.latest : null
  }

  /** Install (or clear) the executor. Returns an uninstall that never clears a newer one. */
  setExecutor(executor: GlanceRemoteExecutor | null): () => void {
    this.executor = executor
    return () => {
      if (this.executor === executor) this.executor = null
    }
  }

  getExecutor(): GlanceRemoteExecutor | null {
    return this.executor
  }

  private recompute(now: number): boolean {
    const demand = this.demand(now)
    const key = demand ? JSON.stringify(demand) : ""
    if (key === this.demandKey) return false
    this.demandKey = key
    if (!demand) this.latest = null
    for (const listener of this.listeners) listener()
    return true
  }
}

/** The lease window for phones: their renewals ride a network, so the same TTL as the tray panel's 60 s. */
export const GLANCE_REMOTE_LEASE_TTL_MS = 60_000

/** The one hub per desktop main window. */
export const glanceRemoteHub = new GlanceRemoteHub(GLANCE_REMOTE_LEASE_TTL_MS)
