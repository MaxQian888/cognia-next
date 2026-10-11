import { GRID_PANELS, KPI_PANELS, PANELS, defaultLayouts, panelById } from "./panel-registry"

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
    // The recent-traces panel is gone: `/logs` → Traces → Explore IS the list,
    // over the same window and the same filters.
    expect(kinds).not.toContain("traces")
    expect(PANELS.filter((p) => p.kind === "stat")).toHaveLength(8)
  })

  it("plots every breakdown `useObservabilitySeries` computes", () => {
    const dimensions = PANELS.map((p) => p.dimension).filter(Boolean)
    expect(new Set(dimensions)).toEqual(
      new Set(["model", "surface", "provider", "project", "operation", "tool"])
    )
  })

  it("gives every stat metric a home", () => {
    const metrics = PANELS.filter((p) => p.kind === "stat").map((p) => p.statMetric)
    expect(new Set(metrics)).toEqual(
      new Set([
        "totalCost",
        "totalSpans",
        "errorRate",
        "cacheHitRate",
        "p95Latency",
        "reqPerMin",
        "toolCalls",
        "toolFailures",
      ])
    )
  })

  it("looks up panels by id", () => {
    expect(panelById("kpi-cost")?.statMetric).toBe("totalCost")
    expect(panelById("nope")).toBeUndefined()
  })

  it("splits the catalog into the KPI strip and the grid, losing nothing", () => {
    expect(KPI_PANELS.every((p) => p.kind === "stat")).toBe(true)
    expect(GRID_PANELS.some((p) => p.kind === "stat")).toBe(false)
    expect([...KPI_PANELS, ...GRID_PANELS].map((p) => p.id).sort()).toEqual(
      PANELS.map((p) => p.id).sort()
    )
  })

  describe("defaultLayouts", () => {
    const layouts = defaultLayouts()

    it("covers every grid panel — and no KPI — in every breakpoint", () => {
      for (const bp of ["lg", "md", "sm"] as const) {
        const ids = layouts[bp].map((l) => l.i).sort()
        expect(ids).toEqual(GRID_PANELS.map((p) => p.id).sort())
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

    it("keeps sm items within the 2-column phone grid", () => {
      for (const item of layouts.sm) {
        expect(item.x + item.w).toBeLessThanOrEqual(2)
      }
    })

    it("keeps every chart full-width on a phone", () => {
      for (const item of layouts.sm) {
        expect(item.w).toBe(2)
      }
    })

    it("never overlaps two panels on the phone grid", () => {
      const cells = new Set<string>()
      for (const item of layouts.sm) {
        for (let x = item.x; x < item.x + item.w; x++) {
          for (let y = item.y; y < item.y + item.h; y++) {
            const key = `${x}:${y}`
            expect(cells.has(key)).toBe(false)
            cells.add(key)
          }
        }
      }
    })
  })
})
