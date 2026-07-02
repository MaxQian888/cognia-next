import {
  ADVANCED_MODES,
  PERMISSION_MODE_META,
  SAFE_CYCLE_MODES,
  permissionModeMeta,
  permissionRiskMarker,
} from "./permission-mode-meta"
import { PERMISSION_MODES } from "../../config/schema"

describe("PERMISSION_MODE_META", () => {
  it("describes every permission mode (exhaustive, no drift)", () => {
    for (const mode of PERMISSION_MODES) {
      const meta = PERMISSION_MODE_META[mode]
      expect(meta).toBeDefined()
      expect(meta.label.trim().length).toBeGreaterThan(0)
      expect(meta.runsWithoutAsking.trim().length).toBeGreaterThan(0)
      expect(["safe", "elevated", "danger"]).toContain(meta.risk)
    }
    // No stray keys beyond the enum.
    expect(Object.keys(PERMISSION_MODE_META).sort()).toEqual([...PERMISSION_MODES].sort())
  })

  it("flags bypassPermissions as the only danger-tier mode", () => {
    expect(PERMISSION_MODE_META.bypassPermissions.risk).toBe("danger")
    expect(PERMISSION_MODE_META.default.risk).toBe("safe")
    expect(PERMISSION_MODE_META.plan.risk).toBe("safe")
  })
})

describe("SAFE_CYCLE_MODES / ADVANCED_MODES", () => {
  it("cycles only the safe core and partitions the rest as advanced", () => {
    expect(SAFE_CYCLE_MODES).toEqual(["default", "acceptEdits", "plan"])
    expect(ADVANCED_MODES).toEqual(expect.arrayContaining(["bypassPermissions", "dontAsk", "auto"]))
    // The two sets partition PERMISSION_MODES with no overlap.
    const union = new Set([...SAFE_CYCLE_MODES, ...ADVANCED_MODES])
    expect(union).toEqual(new Set(PERMISSION_MODES))
    for (const m of SAFE_CYCLE_MODES) expect(ADVANCED_MODES).not.toContain(m)
  })
})

describe("permissionModeMeta / permissionRiskMarker", () => {
  it("returns a safe fallback for an unknown mode", () => {
    const meta = permissionModeMeta("bogus" as never)
    expect(meta.risk).toBe("safe")
    expect(meta.label).toBe("bogus")
  })

  it("marks danger with ⚠, elevated with •, and safe with nothing", () => {
    expect(permissionRiskMarker("bypassPermissions")).toBe("⚠ ")
    expect(permissionRiskMarker("acceptEdits")).toBe("• ")
    expect(permissionRiskMarker("default")).toBe("")
  })
})
