import {
  calculateUptime,
  createPreviewStatusSnapshot,
  deriveOverallStatus,
  sortIncidentUpdatesNewestFirst,
  type DailyAvailability,
} from "./public-status"

describe("public status data contract", () => {
  it("derives the most severe component state without letting maintenance mask an outage", () => {
    expect(deriveOverallStatus(["operational", "maintenance"])).toBe("maintenance")
    expect(deriveOverallStatus(["maintenance", "degraded"])).toBe("degraded")
    expect(deriveOverallStatus(["major_outage", "maintenance", "partial_outage"])).toBe(
      "major_outage"
    )
  })

  it("calculates uptime from the measured availability values", () => {
    const history: DailyAvailability[] = [
      { date: "2026-08-09", status: "operational", availabilityPercent: 100 },
      { date: "2026-08-10", status: "degraded", availabilityPercent: 99.5 },
      { date: "2026-08-11", status: "partial_outage", availabilityPercent: 98.5 },
    ]

    expect(calculateUptime(history)).toBe(99.33)
    expect(calculateUptime([])).toBe(100)
  })

  it("ships deterministic degraded and operational preview snapshots", () => {
    const degraded = createPreviewStatusSnapshot()
    const operational = createPreviewStatusSnapshot("operational")

    expect(deriveOverallStatus(degraded.components.map((component) => component.status))).toBe(
      "degraded"
    )
    expect(degraded.generatedAt).toBe("2026-08-11T08:42:00.000Z")
    expect(degraded.components).toHaveLength(5)
    expect(degraded.components.every((component) => component.history.length === 90)).toBe(true)
    expect(degraded.activeIncidents).toHaveLength(1)

    expect(deriveOverallStatus(operational.components.map((component) => component.status))).toBe(
      "operational"
    )
    expect(operational.activeIncidents).toHaveLength(0)
    expect(
      operational.components.every((component) =>
        component.history.every((day) => day.status === "operational")
      )
    ).toBe(true)
  })

  it("orders incident updates newest first without mutating the source", () => {
    const updates = [
      { id: "investigating" as const, state: "investigating" as const, at: "2026-08-11T07:58:00Z" },
      { id: "monitoring" as const, state: "monitoring" as const, at: "2026-08-11T08:31:00Z" },
      { id: "identified" as const, state: "identified" as const, at: "2026-08-11T08:16:00Z" },
    ]

    expect(sortIncidentUpdatesNewestFirst(updates).map((update) => update.state)).toEqual([
      "monitoring",
      "identified",
      "investigating",
    ])
    expect(updates[0].state).toBe("investigating")
  })
})
