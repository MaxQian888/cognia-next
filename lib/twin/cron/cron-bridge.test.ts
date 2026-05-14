/**
 * Coverage for the M5 cron-bridge. Uses real Dexie (fake-indexeddb) so
 * the scheduler-db round-trip is exercised end-to-end.
 */

import "fake-indexeddb/auto"
import { syncTwinCronToScheduler, CRON_PRESETS } from "./cron-bridge"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"

beforeEach(async () => {
  await schedulerDb.delete()
  await schedulerDb.open()
})

describe("syncTwinCronToScheduler", () => {
  it("creates both ingest + distill tasks when both schedules are set", async () => {
    const result = await syncTwinCronToScheduler("twin_a", {
      enabled: true,
      ingestSchedule: CRON_PRESETS[0].value, // every hour
      distillSchedule: CRON_PRESETS[2].value, // daily 03:00
    })
    expect(result.ingest).toBe("created")
    expect(result.distill).toBe("created")
    expect(result.invalidExpressions).toEqual([])

    const ingest = await schedulerDb.getTask("twin::twin_a::ingest")
    const distill = await schedulerDb.getTask("twin::twin_a::distill")
    expect(ingest?.type).toBe("twin")
    expect(ingest?.trigger.cronExpression).toBe("0 * * * *")
    expect(distill?.trigger.cronExpression).toBe("0 3 * * *")
    expect(ingest?.payload).toMatchObject({ twinId: "twin_a", kind: "ingest" })
    expect(distill?.payload).toMatchObject({ twinId: "twin_a", kind: "distill" })
  })

  it("updates an existing row instead of duplicating it", async () => {
    await syncTwinCronToScheduler("twin_a", {
      enabled: true,
      ingestSchedule: "0 * * * *",
      distillSchedule: "",
    })
    const result = await syncTwinCronToScheduler("twin_a", {
      enabled: true,
      ingestSchedule: "0 */6 * * *",
      distillSchedule: "",
    })
    expect(result.ingest).toBe("updated")
    const ingest = await schedulerDb.getTask("twin::twin_a::ingest")
    expect(ingest?.trigger.cronExpression).toBe("0 */6 * * *")
  })

  it("deletes the matching task when its schedule is cleared", async () => {
    await syncTwinCronToScheduler("twin_a", {
      enabled: true,
      ingestSchedule: "0 * * * *",
      distillSchedule: "0 3 * * *",
    })
    const result = await syncTwinCronToScheduler("twin_a", {
      enabled: true,
      ingestSchedule: "",
      distillSchedule: "0 3 * * *",
    })
    expect(result.ingest).toBe("deleted")
    expect(result.distill).toBe("updated")
    expect(await schedulerDb.getTask("twin::twin_a::ingest")).toBeNull()
    expect(await schedulerDb.getTask("twin::twin_a::distill")).not.toBeNull()
  })

  it("deletes both tasks when enabled flips to false", async () => {
    await syncTwinCronToScheduler("twin_a", {
      enabled: true,
      ingestSchedule: "0 * * * *",
      distillSchedule: "0 3 * * *",
    })
    const result = await syncTwinCronToScheduler("twin_a", {
      enabled: false,
      ingestSchedule: "0 * * * *",
      distillSchedule: "0 3 * * *",
    })
    expect(result.ingest).toBe("deleted")
    expect(result.distill).toBe("deleted")
  })

  it("does nothing for an undefined cron block when no prior rows exist", async () => {
    const result = await syncTwinCronToScheduler("twin_a", undefined)
    expect(result.ingest).toBe("skipped")
    expect(result.distill).toBe("skipped")
  })

  it("reports invalid cron expressions without writing rows", async () => {
    const result = await syncTwinCronToScheduler("twin_a", {
      enabled: true,
      ingestSchedule: "not a cron",
      distillSchedule: "also bad",
    })
    expect(result.invalidExpressions).toEqual(["ingest: not a cron", "distill: also bad"])
    expect(await schedulerDb.getTask("twin::twin_a::ingest")).toBeNull()
    expect(await schedulerDb.getTask("twin::twin_a::distill")).toBeNull()
  })

  it("namespaces tasks per-twin so other twins are unaffected", async () => {
    await syncTwinCronToScheduler("twin_a", {
      enabled: true,
      ingestSchedule: "0 * * * *",
      distillSchedule: "",
    })
    await syncTwinCronToScheduler("twin_b", {
      enabled: true,
      ingestSchedule: "0 */6 * * *",
      distillSchedule: "",
    })
    expect((await schedulerDb.getTask("twin::twin_a::ingest"))?.trigger.cronExpression).toBe(
      "0 * * * *"
    )
    expect((await schedulerDb.getTask("twin::twin_b::ingest"))?.trigger.cronExpression).toBe(
      "0 */6 * * *"
    )
  })
})
