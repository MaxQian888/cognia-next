import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"

import {
  GLANCE_REMOTE_LEASE_TTL_MS,
  GlanceRemoteHub,
  glanceRemoteHub,
  type GlanceRemoteExecutor,
} from "./host-hub"
import type { GlanceRemoteDemand } from "./types"

const TTL = 60_000
const T0 = 1_000_000

const demand = (patch: Partial<GlanceRemoteDemand> = {}): GlanceRemoteDemand => ({
  modules: ["fleet", "usage"],
  catalog: false,
  scope: "all",
  workspaceId: null,
  usage: { scope: "cognia", showSpend: false },
  activity: { range: "3m" },
  ...patch,
})

const snapshot = (revision = 1) => ({ marker: "snap", revision }) as unknown as GlanceSnapshotV1

const executor = (): GlanceRemoteExecutor => ({
  refresh: jest.fn(async () => null),
  quotaRefresh: jest.fn(async () => null),
  quotaEnable: jest.fn(async () => null),
})

describe("GlanceRemoteHub", () => {
  let hub: GlanceRemoteHub

  beforeEach(() => {
    hub = new GlanceRemoteHub(TTL)
  })

  it("exposes its TTL", () => {
    expect(hub.leaseTtlMs).toBe(TTL)
  })

  it("starts with no lease, no demand and an empty key", () => {
    expect(hub.hasLive(T0)).toBe(false)
    expect(hub.demand(T0)).toBeNull()
    expect(hub.getDemandKey()).toBe("")
    expect(hub.getLatest(T0)).toBeNull()
    expect(hub.getExecutor()).toBeNull()
  })

  describe("announce", () => {
    it("records a visible lease and reports the change", () => {
      expect(hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)).toBe(true)
      expect(hub.hasLive(T0)).toBe(true)
      expect(hub.demand(T0)).toEqual(demand())
      expect(hub.getDemandKey()).toBe(JSON.stringify(demand()))
    })

    it("an identical renewal changes nothing and extends the lease", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      expect(hub.announce({ consumer: "a", visible: true, demand: demand() }, T0 + 50_000)).toBe(
        false
      )
      // The original would have lapsed at T0 + TTL; the renewal carries it on.
      expect(hub.hasLive(T0 + TTL + 10_000)).toBe(true)
      expect(hub.hasLive(T0 + 50_000 + TTL)).toBe(false)
    })

    it("ends a lease on visible: false", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      expect(hub.announce({ consumer: "a", visible: false, demand: demand() }, T0 + 1)).toBe(true)
      expect(hub.hasLive(T0 + 1)).toBe(false)
      expect(hub.getDemandKey()).toBe("")
    })

    it("ending an unknown lease is a no-op", () => {
      expect(hub.announce({ consumer: "ghost", visible: false, demand: demand() }, T0)).toBe(false)
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      expect(hub.announce({ consumer: "ghost", visible: false, demand: demand() }, T0)).toBe(false)
      expect(hub.hasLive(T0)).toBe(true)
    })

    it("merges the demands of several phones", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand({ modules: ["usage"] }) }, T0)
      hub.announce({ consumer: "b", visible: true, demand: demand({ modules: ["pet"] }) }, T0 + 1)
      expect(hub.demand(T0 + 1)?.modules).toEqual(["usage", "pet"])
    })
  })

  describe("announcedAt", () => {
    const A = demand({ modules: ["activity"], activity: { range: "1y" } })
    const B = demand({ modules: ["activity"], activity: { range: "1m" } })

    it("is kept across identical renewals, so two phones do not flip the options", () => {
      hub.announce({ consumer: "a", visible: true, demand: A }, T0)
      hub.announce({ consumer: "b", visible: true, demand: B }, T0 + 1)
      expect(hub.demand(T0 + 1)?.activity.range).toBe("1m")
      // a renews later; b's change is still the newest.
      expect(hub.announce({ consumer: "a", visible: true, demand: A }, T0 + 20_000)).toBe(false)
      expect(hub.demand(T0 + 20_000)?.activity.range).toBe("1m")
      hub.announce({ consumer: "b", visible: true, demand: B }, T0 + 20_001)
      expect(hub.demand(T0 + 20_001)?.activity.range).toBe("1m")
    })

    it("is bumped when a lease's demand changes", () => {
      hub.announce({ consumer: "a", visible: true, demand: A }, T0)
      hub.announce({ consumer: "b", visible: true, demand: B }, T0 + 1)
      const changedA = demand({ modules: ["activity", "fleet"], activity: { range: "3m" } })
      expect(hub.announce({ consumer: "a", visible: true, demand: changedA }, T0 + 10)).toBe(true)
      expect(hub.demand(T0 + 10)).toEqual({ ...changedA, modules: ["activity", "fleet"] })
    })

    it("is bumped when a lapsed lease comes back with the same demand", () => {
      hub.announce({ consumer: "a", visible: true, demand: A }, T0)
      hub.announce({ consumer: "b", visible: true, demand: B }, T0 + TTL - 1)
      // a lapsed at T0 + TTL; its return is a fresh announcement.
      hub.announce({ consumer: "a", visible: true, demand: A }, T0 + TTL + 5)
      expect(hub.demand(T0 + TTL + 5)?.activity.range).toBe("1y")
    })
  })

  describe("prune", () => {
    it("drops lapsed leases and reports a change", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand({ modules: ["usage"] }) }, T0)
      hub.announce(
        { consumer: "b", visible: true, demand: demand({ modules: ["pet"] }) },
        T0 + 30_000
      )
      expect(hub.prune(T0 + TTL)).toBe(true)
      expect(hub.demand(T0 + TTL)?.modules).toEqual(["pet"])
      expect(hub.hasLive(T0 + TTL)).toBe(true)
    })

    it("reports nothing when no lease lapsed", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      expect(hub.prune(T0 + TTL - 1)).toBe(false)
      expect(hub.prune(T0)).toBe(false)
    })

    it("treats a lease exactly at its expiry as lapsed", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      expect(hub.hasLive(T0 + TTL)).toBe(false)
      expect(hub.prune(T0 + TTL)).toBe(true)
      expect(hub.getDemandKey()).toBe("")
    })

    it("reports no change when dropping a lease leaves the merged demand equal", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      hub.announce({ consumer: "b", visible: true, demand: demand() }, T0 + 30_000)
      expect(hub.prune(T0 + TTL)).toBe(false)
      expect(hub.hasLive(T0 + TTL)).toBe(true)
    })

    it("a lapsed but unpruned lease no longer counts toward the demand", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      expect(hub.demand(T0 + TTL)).toBeNull()
    })
  })

  describe("demand key and listeners", () => {
    it("calls listeners only when the merged demand changes", () => {
      const listener = jest.fn()
      hub.subscribe(listener)
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      expect(listener).toHaveBeenCalledTimes(1)
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0 + 1)
      hub.announce({ consumer: "b", visible: true, demand: demand() }, T0 + 2)
      expect(listener).toHaveBeenCalledTimes(1)
      hub.announce({ consumer: "b", visible: true, demand: demand({ modules: ["pet"] }) }, T0 + 3)
      expect(listener).toHaveBeenCalledTimes(2)
      hub.prune(T0 + 3 + TTL)
      expect(listener).toHaveBeenCalledTimes(3)
    })

    it("keeps the key stable across renewals", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      const key = hub.getDemandKey()
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0 + 1000)
      expect(hub.getDemandKey()).toBe(key)
    })

    it("stops calling an unsubscribed listener", () => {
      const listener = jest.fn()
      const off = hub.subscribe(listener)
      off()
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      expect(listener).not.toHaveBeenCalled()
    })

    it("getDemandKey and subscribe work detached from the instance", () => {
      const { getDemandKey, subscribe } = hub
      const listener = jest.fn()
      subscribe(listener)
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      expect(getDemandKey()).toBe(JSON.stringify(demand()))
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  describe("latest", () => {
    it("is null without a live lease, even when set", () => {
      hub.setLatest(snapshot())
      expect(hub.getLatest(T0)).toBeNull()
    })

    it("returns the stored snapshot while a lease is live", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      const snap = snapshot()
      hub.setLatest(snap)
      expect(hub.getLatest(T0 + 1)).toBe(snap)
      expect(hub.getLatest(T0 + TTL)).toBeNull()
    })

    it("is cleared when the demand becomes empty", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      hub.setLatest(snapshot())
      hub.announce({ consumer: "a", visible: false, demand: demand() }, T0 + 1)
      // A new lease must not receive the build made for the old one.
      hub.announce({ consumer: "b", visible: true, demand: demand() }, T0 + 2)
      expect(hub.getLatest(T0 + 2)).toBeNull()
    })

    it("is kept when the demand changes but stays non-empty", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      const snap = snapshot()
      hub.setLatest(snap)
      hub.announce({ consumer: "a", visible: true, demand: demand({ modules: ["pet"] }) }, T0 + 1)
      expect(hub.getLatest(T0 + 1)).toBe(snap)
    })

    it("can be cleared by the publisher", () => {
      hub.announce({ consumer: "a", visible: true, demand: demand() }, T0)
      hub.setLatest(snapshot())
      hub.setLatest(null)
      expect(hub.getLatest(T0)).toBeNull()
    })
  })

  describe("executor", () => {
    it("installs and uninstalls an executor", () => {
      const ex = executor()
      const uninstall = hub.setExecutor(ex)
      expect(hub.getExecutor()).toBe(ex)
      uninstall()
      expect(hub.getExecutor()).toBeNull()
    })

    it("an old uninstall never clears a newer executor", () => {
      const first = executor()
      const second = executor()
      const uninstallFirst = hub.setExecutor(first)
      hub.setExecutor(second)
      uninstallFirst()
      expect(hub.getExecutor()).toBe(second)
    })

    it("setExecutor(null) clears it", () => {
      hub.setExecutor(executor())
      hub.setExecutor(null)
      expect(hub.getExecutor()).toBeNull()
    })
  })
})

describe("glanceRemoteHub", () => {
  it("is one shared hub with the phone lease TTL", () => {
    expect(glanceRemoteHub).toBeInstanceOf(GlanceRemoteHub)
    expect(glanceRemoteHub.leaseTtlMs).toBe(GLANCE_REMOTE_LEASE_TTL_MS)
    expect(GLANCE_REMOTE_LEASE_TTL_MS).toBe(60_000)
  })
})
