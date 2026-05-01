import {
  DOMAIN_SNAPSHOT_MODULES,
  SNAPSHOT_MODULES,
  browserSnapshotStorage,
  getSnapshotModule,
  listSnapshotKeys,
} from "./registry"

describe("snapshot registry", () => {
  it("registers exactly the planned 12 modules", () => {
    expect(SNAPSHOT_MODULES).toHaveLength(12)
    expect(new Set(listSnapshotKeys())).toEqual(
      new Set([
        "cognia-external-agents",
        "cognia-custom-modes",
        "cognia-agent-teams",
        "cognia-next.agent-runtime",
        "cognia-custom-themes",
        "cognia-artifacts",
        "cognia-a2ui-surfaces",
        "cognia-canvas-keybindings",
        "cognia-canvas-comments",
        "cognia-canvas-settings",
        "cognia-scheduler",
        "cognia-ui",
      ])
    )
  })

  it("does not have any duplicate keys", () => {
    const keys = listSnapshotKeys()
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("exposes domain modules — UI prefs are excluded", () => {
    const domainKeys = DOMAIN_SNAPSHOT_MODULES.map((m) => m.key)
    expect(domainKeys).toContain("cognia-external-agents")
    expect(domainKeys).toContain("cognia-custom-modes")
    expect(domainKeys).not.toContain("cognia-ui")
  })

  it("getSnapshotModule round-trips by key", () => {
    expect(getSnapshotModule("cognia-external-agents")?.labelKey).toBe("externalAgents")
    expect(getSnapshotModule("not-a-real-key")).toBeUndefined()
  })

  describe("browserSnapshotStorage", () => {
    const original = (globalThis as { localStorage?: Storage }).localStorage

    afterEach(() => {
      if (original) {
        ;(globalThis as { localStorage?: Storage }).localStorage = original
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage
      }
    })

    it("returns null when localStorage is unavailable", () => {
      delete (globalThis as { localStorage?: Storage }).localStorage
      expect(browserSnapshotStorage()).toBeNull()
    })

    it("wraps the global localStorage when present", () => {
      const fake: Storage = {
        getItem: (k) => `value-of-${k}`,
        setItem: jest.fn(),
        removeItem: jest.fn(),
        clear: jest.fn(),
        key: () => null,
        length: 0,
      }
      ;(globalThis as { localStorage?: Storage }).localStorage = fake
      const wrapped = browserSnapshotStorage()
      expect(wrapped?.getItem("a")).toBe("value-of-a")
      wrapped?.setItem("k", "v")
      expect(fake.setItem).toHaveBeenCalledWith("k", "v")
      wrapped?.removeItem("k")
      expect(fake.removeItem).toHaveBeenCalledWith("k")
    })
  })
})
