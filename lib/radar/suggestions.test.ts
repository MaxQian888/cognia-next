/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { decideRadarSuggestion, radarSuggestions } from "./suggestions"
import type { RadarReport } from "@/types/radar"

const mockArm = jest.fn()
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => ({ updateTask: (...args: unknown[]) => mockArm(...args) }),
}))
jest.mock("@/lib/scheduler/host-support", () => ({ assertTaskTypeSupportedOnHost: () => null }))
const report: RadarReport = {
  id: "r",
  scope: "self",
  generatedAt: 1,
  windowDays: 14,
  itemCount: 5,
  heatmap: [],
  verdict: "v",
  atAGlance: [],
  infoDiet: "",
  subconscious: "",
  graveyard: [],
  blindSpots: "",
  actions: ["Research this topic"],
  topicCloud: [],
}

beforeEach(async () => {
  mockArm.mockReset().mockResolvedValue({ id: "task" })
  await getDb().radarReports.clear()
  await getDb().scheduledTasks.clear()
  await getDb().radarReports.put(report)
})

it("atomically persists one decision and one task under concurrent retries", async () => {
  const id = radarSuggestions(report)[0].id
  const results = await Promise.all([
    decideRadarSuggestion("r", id, "accepted"),
    decideRadarSuggestion("r", id, "accepted"),
  ])
  expect(results[0].taskId).toBe(results[1].taskId)
  expect(await getDb().scheduledTasks.count()).toBe(1)
  const task = await schedulerDb.getTask(results[0].taskId!)
  expect(task?.config).toMatchObject({ maxRuns: 1, runMissedOnStartup: true, maxRetries: 0 })
  expect(task).toMatchObject({ type: "goal", payload: { config: { requireAcceptance: true } } })
  expect((await getDb().radarReports.get("r"))?.suggestions?.[0].status).toBe("accepted")
})

it("retains a durable task after dispatch failure and retries arming without replacing it", async () => {
  mockArm.mockRejectedValueOnce(new Error("host unavailable"))
  await expect(decideRadarSuggestion("r", "r:action:0", "accepted")).rejects.toThrow(
    "host unavailable"
  )
  expect((await getDb().radarReports.get("r"))?.suggestions?.[0].dispatchError).toContain(
    "host unavailable"
  )
  await decideRadarSuggestion("r", "r:action:0", "accepted")
  expect(await getDb().scheduledTasks.count()).toBe(1)
  expect((await getDb().radarReports.get("r"))?.suggestions?.[0].dispatchError).toBeUndefined()
})

it("dismisses without execution and refuses an incompatible replay", async () => {
  await decideRadarSuggestion("r", "r:action:0", "dismissed")
  await expect(decideRadarSuggestion("r", "r:action:0", "accepted")).rejects.toThrow(
    "already decided"
  )
  expect(await getDb().scheduledTasks.count()).toBe(0)
  expect(mockArm).not.toHaveBeenCalled()
})
