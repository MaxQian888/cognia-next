import { PANELS, defaultLayouts, panelById } from "./panel-registry"

describe("panel-registry", () => {
  it("defines a unique id for every panel", () => {
    const ids = PANELS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("includes the confirmed panel set", () => {
    const kinds = PANELS.map((p) => p.kind)
    expect(kinds).toContain("stat")
    expect(kinds).toContain("timeseries")
    expect(kinds).toContain("donut")
    expect(kinds).toContain("bar")
    expect(kinds).toContain("traces")
    expect(PANELS.filter((p) => p.kind === "stat")).toHaveLength(5)
  })

  it("looks up panels by id", () => {
    expect(panelById("kpi-cost")?.statMetric).toBe("totalCost")
    expect(panelById("nope")).toBeUndefined()
  })

  describe("defaultLayouts", () => {
    const layouts = defaultLayouts()

    it("covers every panel in every breakpoint", () => {
      for (const bp of ["lg", "md", "sm"] as const) {
        const ids = layouts[bp].map((l) => l.i).sort()
        expect(ids).toEqual(PANELS.map((p) => p.id).sort())
      }
    })

    it("keeps lg items within the 12-column grid", () => {
      for (const item of layouts.lg) {
        expect(item.x + item.w).toBeLessThanOrEqual(12)
      }
    })

    it("keeps md items within the 8-column grid", () => {
      for (const item of layouts.md) {
        expect(item.x + item.w).toBeLessThanOrEqual(8)
      }
    })
  })
})
