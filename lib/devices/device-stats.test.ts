import { buildDeviceStats, type DeviceStatId } from "./device-stats"
import type { DeviceCapabilityCell, DeviceGrantRow, DeviceRow } from "./types"

function cell(overrides: Partial<DeviceCapabilityCell> & { id: string }): DeviceCapabilityCell {
  return { group: "platform", state: "reported", source: "device-report", ...overrides }
}

function grant(overrides: Partial<DeviceGrantRow> & { id: DeviceGrantRow["id"] }): DeviceGrantRow {
  return {
    state: "granted",
    capabilities: [],
    heldCapabilities: [],
    available: true,
    ...overrides,
  }
}

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Phone",
    isSelf: false,
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "request" },
    capabilities: [],
    capabilityReportMissing: false,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY },
    runtime: {
      sandbox: { support: "unsupported", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

describe("buildDeviceStats", () => {
  /**
   * A fixed-width strip would print "—" for most slots on most kinds. Only
   * stats the row can answer are returned, so an empty slot never has to be
   * explained.
   */
  it("omits stats the device cannot answer", () => {
    const stats = buildDeviceStats(row())
    expect(stats.map((stat) => stat.id)).toEqual(["placement"])
  })

  it("reports capabilities as a fraction of the vocabulary", () => {
    const stats = buildDeviceStats(
      row({ capabilities: [cell({ id: "a" }), cell({ id: "b", state: "absent" })] })
    )
    expect(stats.find((stat) => stat.id === "capabilities")).toMatchObject({
      value: 1,
      total: 2,
      tone: "positive",
    })
  })

  /**
   * Never having reported is the fact worth flagging: every cell below it is
   * inference rather than evidence, and a green "0/20" would read as a device
   * that answered and has nothing.
   */
  it("flags a device that has never reported", () => {
    const stats = buildDeviceStats(
      row({
        capabilityReportMissing: true,
        capabilities: [cell({ id: "a", state: "unknown", source: "platform-baseline" })],
      })
    )
    expect(stats.find((stat) => stat.id === "capabilities")?.tone).toBe("attention")
  })

  /**
   * An intentionally inert grant is not a permission the owner withheld, so
   * counting it in the denominator would show a permanent shortfall nobody
   * can close. `lockedComputerUse` is exactly that while it has no
   * enforcement point.
   */
  it("excludes an unavailable grant from the denominator", () => {
    const stats = buildDeviceStats(
      row({
        grants: [
          grant({ id: "control" }),
          grant({ id: "agentControl", state: "denied" }),
          grant({ id: "lockedComputerUse", state: "denied", available: false }),
        ],
      })
    )
    expect(stats.find((stat) => stat.id === "grants")).toMatchObject({ value: 1, total: 2 })
  })

  /**
   * The state this console exists to expose. It reads identically to "off"
   * everywhere else, so it has to outrank a count that would otherwise look
   * healthy.
   */
  it("lets a partial grant outrank the count", () => {
    const stats = buildDeviceStats(
      row({ grants: [grant({ id: "control" }), grant({ id: "agentControl", state: "partial" })] })
    )
    expect(stats.find((stat) => stat.id === "grants")).toMatchObject({
      value: 1,
      tone: "attention",
    })
  })

  it("counts usable shell tiers against the known ones", () => {
    const stats = buildDeviceStats(
      row({
        kind: "local",
        runtime: {
          sandbox: { support: "supported", connections: [] },
          shellTiers: [
            { tier: "os", available: true },
            { tier: "microvm", available: false, reasonKey: "microvmAdapterMissing" },
            { tier: "cua-desktop", available: false, reasonKey: "cuaDesktopNoConnection" },
          ],
          workspaces: { support: "supported" },
          isRoutingTarget: true,
        },
      })
    )
    expect(stats.find((stat) => stat.id === "shellTiers")).toMatchObject({
      value: 1,
      total: 3,
      tone: "positive",
    })
  })

  it("flags a device with no usable tier at all", () => {
    const stats = buildDeviceStats(
      row({
        runtime: {
          sandbox: { support: "unsupported", connections: [] },
          shellTiers: [{ tier: "os", available: false, reasonKey: "osBackendUnavailable" }],
          workspaces: { support: "unsupported" },
          isRoutingTarget: false,
        },
      })
    )
    expect(stats.find((stat) => stat.id === "shellTiers")?.tone).toBe("attention")
  })

  /**
   * Two `platform` requirements still answer exactly one kind of question a
   * caller can ask, so the strip counts dimensions rather than requirements.
   */
  it("counts distinct placement dimensions, not requirements", () => {
    const stats = buildDeviceStats(
      row({
        placement: {
          provides: [
            { dimension: "platform", value: "camera" },
            { dimension: "platform", value: "shell" },
            { dimension: "sandbox", value: "os" },
          ],
          activeUnits: 0,
          maxUnits: Number.POSITIVE_INFINITY,
        },
      })
    )
    expect(stats.find((stat) => stat.id === "placement")).toMatchObject({ value: 2 })
  })

  /**
   * The single most useful thing the strip can say: no requirement can ever
   * match this device, so automatic selection will never pick it.
   */
  it("flags a device that offers placement nothing", () => {
    const stats = buildDeviceStats(row())
    expect(stats.find((stat) => stat.id === "placement")).toMatchObject({
      value: 0,
      tone: "attention",
    })
  })

  it("never returns a fraction whose value exceeds its total", () => {
    const stats = buildDeviceStats(
      row({
        capabilities: [cell({ id: "a" }), cell({ id: "b" })],
        grants: [grant({ id: "control" })],
        runtime: {
          sandbox: { support: "supported", connections: [] },
          shellTiers: [{ tier: "os", available: true }],
          workspaces: { support: "supported" },
          isRoutingTarget: true,
        },
      })
    )
    for (const stat of stats) {
      if (stat.total !== undefined) expect(stat.value).toBeLessThanOrEqual(stat.total)
    }
  })
})

/**
 * `lint:i18n` cannot see `` t(`stat.${stat.id}`) ``, so the catalogue is
 * pinned here instead — the same guard `placement-directory.test.ts` uses for
 * `PlacementReason`. Without it, adding a stat id ships a masthead tile
 * captioned with its raw enum value.
 */
describe("stat labels", () => {
  const IDS: readonly DeviceStatId[] = ["capabilities", "grants", "shellTiers", "placement"]

  it.each(["en", "zh-CN"])("has a label for every stat in %s", (locale) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messages = require(`../../i18n/messages/${locale}/devices.json`) as {
      stat: Record<string, string>
    }
    for (const id of IDS) {
      expect(typeof messages.stat[id]).toBe("string")
      expect(messages.stat[id]!.length).toBeGreaterThan(0)
    }
  })

  it("covers the whole union, so a new member fails here first", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messages = require("../../i18n/messages/en/devices.json") as {
      stat: Record<string, string>
    }
    expect(Object.keys(messages.stat).sort()).toEqual([...IDS].sort())
  })
})
