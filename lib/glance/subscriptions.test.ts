import { GlanceSubscriptionRegistry } from "./subscriptions"

const TTL = 60_000
const NOW = 1_000_000

const sub = (consumer = "tray-panel", windowLabel = "tray-panel", visible = true) => ({
  consumer,
  windowLabel,
  visible,
})

describe("GlanceSubscriptionRegistry", () => {
  let registry: GlanceSubscriptionRegistry

  beforeEach(() => {
    registry = new GlanceSubscriptionRegistry(TTL)
  })

  describe("announce", () => {
    it("returns true for the first visible announcement", () => {
      expect(registry.announce(sub(), NOW)).toBe(true)
      expect(registry.hasLive(NOW)).toBe(true)
    })

    it("returns false when the same window renews", () => {
      registry.announce(sub(), NOW)
      expect(registry.announce(sub(), NOW + 20_000)).toBe(false)
    })

    it("extends the lease on renewal", () => {
      registry.announce(sub(), NOW)
      registry.announce(sub(), NOW + 50_000)
      expect(registry.hasLive(NOW + TTL + 1)).toBe(true)
      expect(registry.hasLive(NOW + 50_000 + TTL)).toBe(false)
    })

    it("returns true when the window changes", () => {
      registry.announce(sub("c", "w1"), NOW)
      expect(registry.announce(sub("c", "w2"), NOW + 1)).toBe(true)
      expect(registry.windowOf("c", NOW + 1)).toBe("w2")
    })

    it("returns true when announcing over an expired lease", () => {
      registry.announce(sub(), NOW)
      expect(registry.announce(sub(), NOW + TTL)).toBe(true)
    })

    it("returns true when a live lease is ended", () => {
      registry.announce(sub(), NOW)
      expect(registry.announce(sub("tray-panel", "tray-panel", false), NOW + 1)).toBe(true)
      expect(registry.hasLive(NOW + 1)).toBe(false)
    })

    it("returns false when ending a lease that does not exist", () => {
      expect(registry.announce(sub("ghost", "w", false), NOW)).toBe(false)
    })

    it("returns false when ending a lease that already lapsed", () => {
      registry.announce(sub(), NOW)
      expect(registry.announce(sub("tray-panel", "tray-panel", false), NOW + TTL + 5)).toBe(false)
      expect(registry.live(NOW + TTL + 5)).toEqual([])
    })

    it("tracks consumers independently", () => {
      registry.announce(sub("a", "wa"), NOW)
      expect(registry.announce(sub("b", "wb"), NOW)).toBe(true)
      registry.announce(sub("a", "wa", false), NOW + 1)
      expect(registry.live(NOW + 1).map((l) => l.consumer)).toEqual(["b"])
    })
  })

  describe("prune", () => {
    it("drops expired leases and reports it", () => {
      registry.announce(sub("a"), NOW)
      registry.announce(sub("b"), NOW + 30_000)
      expect(registry.prune(NOW + TTL)).toBe(true)
      expect(registry.live(NOW + TTL).map((l) => l.consumer)).toEqual(["b"])
    })

    it("reports false when nothing lapsed", () => {
      registry.announce(sub(), NOW)
      expect(registry.prune(NOW + 1)).toBe(false)
      expect(registry.prune(NOW + 1)).toBe(false)
    })

    it("reports false on an empty registry", () => {
      expect(registry.prune(NOW)).toBe(false)
    })

    it("makes a lapsed consumer announce as new again", () => {
      registry.announce(sub(), NOW)
      registry.prune(NOW + TTL)
      expect(registry.announce(sub(), NOW + TTL + 1)).toBe(true)
    })
  })

  describe("expiry", () => {
    it("honours the boundary: a lease expiring exactly now is not live", () => {
      registry.announce(sub(), NOW)
      expect(registry.live(NOW + TTL - 1)).toHaveLength(1)
      expect(registry.live(NOW + TTL)).toEqual([])
      expect(registry.hasLive(NOW + TTL)).toBe(false)
      expect(registry.windowOf("tray-panel", NOW + TTL)).toBeNull()
    })

    it("returns lease details from live", () => {
      registry.announce(sub("c", "win"), NOW)
      expect(registry.live(NOW)).toEqual([
        { consumer: "c", windowLabel: "win", expiresAt: NOW + TTL },
      ])
    })

    it("windowOf returns the label while live and null for unknown consumers", () => {
      registry.announce(sub("c", "win"), NOW)
      expect(registry.windowOf("c", NOW + 1)).toBe("win")
      expect(registry.windowOf("other", NOW + 1)).toBeNull()
    })

    it("hasLive is false on an empty registry", () => {
      expect(registry.hasLive(NOW)).toBe(false)
    })
  })
})
