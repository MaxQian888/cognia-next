import "fake-indexeddb/auto"
import {
  saveRadarReport,
  getRadarReport,
  getLatestRadarReport,
  listRadarReports,
  pruneRadarReports,
} from "./radar-reports"
import type { RadarReport } from "@/types/radar"
import { getDb } from "./schema"

beforeEach(async () => {
  await getDb().radarReports.clear()
}, 30_000)

function report(id: string, generatedAt: number): RadarReport {
  return {
    id,
    scope: "self",
    generatedAt,
    windowDays: 14,
    itemCount: 5,
    heatmap: [],
    verdict: "v",
    atAGlance: [],
    infoDiet: "",
    subconscious: "",
    graveyard: [],
    blindSpots: "",
    actions: [],
    topicCloud: [],
  }
}

describe("radar-reports CRUD", () => {
  it("saves, reads by id, and returns the latest for a scope", async () => {
    await saveRadarReport(report("r1", 1000))
    await saveRadarReport(report("r2", 2000))
    expect((await getRadarReport("r1"))?.generatedAt).toBe(1000)
    expect((await getLatestRadarReport("self"))?.id).toBe("r2")
  })

  it("lists newest-first and prunes to the newest N", async () => {
    for (let i = 0; i < 5; i++) await saveRadarReport(report(`p${i}`, i * 1000))
    const list = await listRadarReports(3)
    expect(list.map((r) => r.id)).toEqual(["p4", "p3", "p2"])

    const pruned = await pruneRadarReports(2)
    expect(pruned).toBeGreaterThanOrEqual(1)
    expect((await listRadarReports(50)).length).toBe(2)
  })
})
