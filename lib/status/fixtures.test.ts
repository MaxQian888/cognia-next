import { COMPONENT_IDS } from "./contract"
import { createStatusFixture, FIXTURE_NOW_MS } from "./fixtures"
import { parsePublicSnapshot } from "./validate"

describe("status fixtures", () => {
  it.each(["24h", "7d", "30d", "90d"] as const)("produce range-sized history for %s", (range) => {
    const fixture = createStatusFixture("operational", range)
    const expected = { "24h": 24, "7d": 7, "30d": 30, "90d": 90 }[range]
    expect(fixture.range).toBe(range)
    expect(fixture.components.map((component) => component.id)).toEqual([...COMPONENT_IDS])
    for (const component of fixture.components) expect(component.history).toHaveLength(expected)
    expect(parsePublicSnapshot(fixture).ok).toBe(true)
  })

  it("never invents availability before observation started", () => {
    const fixture = createStatusFixture("operational", "90d")
    const first = fixture.components[0].history[0]
    expect(Date.parse(first.end)).toBeLessThan(Date.parse(fixture.observationStartedAt!))
    expect(first.status).toBe("no_data")
    expect(first.availability.observedAvailability).toBeNull()
  })

  it("shows unknown, not operational, without probes", () => {
    const empty = createStatusFixture("empty")
    expect(empty.overallStatus).toBe("unknown")
    expect(empty.monitoringStatus).toBe("unknown")
    expect(empty.overall.availability.observedAvailability).toBeNull()
    expect(empty.probes).toEqual([])
  })

  it("keeps a stale reference visible as unknown with degraded monitoring", () => {
    const stale = createStatusFixture("unknown")
    expect(stale.overallStatus).toBe("unknown")
    expect(stale.monitoringStatus).toBe("degraded")
  })

  it("derives the overall status from components", () => {
    expect(createStatusFixture("major_outage").overallStatus).toBe("major_outage")
    expect(createStatusFixture("major_outage").activeIncidents).toHaveLength(1)
    expect(createStatusFixture("maintenance").overallStatus).toBe("maintenance")
    expect(createStatusFixture("operational").overallStatus).toBe("operational")
    expect(createStatusFixture("operational").monitoringStatus).toBe("limited")
  })

  it("is deterministic", () => {
    expect(createStatusFixture("degraded")).toEqual(createStatusFixture("degraded"))
    expect(Date.parse(createStatusFixture().serverTime)).toBe(FIXTURE_NOW_MS)
  })
})
