import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { MaintenanceView } from "../../../../../lib/status/contract"
import { excludedMinuteCount, mergeMinuteWindows } from "../../../../../lib/status/derive"
import { resetAccessKeyCache } from "../admin/access"
import { handleAdminRoutes } from "../admin"
import {
  T0,
  MINUTE,
  accessKeys,
  adminCall,
  baseEnv,
  count,
  jobAt,
  jwksFetch,
  operationId,
  readJson,
  resetOwnerE,
  stealLease,
  type AccessKeys,
} from "../admin/test-support"
import {
  activeMaintenanceComponents,
  advanceMaintenance,
  loadExclusionWindows,
  loadMaintenanceForSnapshot,
} from "./index"
import { changedPastMinutes, exclusionWindow } from "./store"

let keys: AccessKeys
const HOUR = 60 * MINUTE
const iso = (ms: number) => new Date(ms).toISOString()

beforeAll(async () => {
  keys = await accessKeys("maint-kid")
})

async function schedule(
  nowMs: number,
  startsAtMs: number,
  endsAtMs: number,
  componentIds: string[] = ["relayData"],
  exclude = true
): Promise<Response> {
  return adminCall(handleAdminRoutes, {
    keys,
    nowMs,
    method: "POST",
    path: "/admin/maintenance",
    body: {
      operationId: operationId("sched"),
      title: { en: "Relay upgrade", "zh-CN": "中继升级" },
      description: { en: "Rolling restart of relay nodes." },
      componentIds,
      startsAt: iso(startsAtMs),
      endsAt: iso(endsAtMs),
      excludeFromAvailability: exclude,
    },
  })
}

async function scheduled(
  nowMs: number,
  startsAtMs: number,
  endsAtMs: number,
  componentIds?: string[]
): Promise<MaintenanceView> {
  const response = await schedule(nowMs, startsAtMs, endsAtMs, componentIds)
  expect(response.status).toBe(201)
  return (await readJson<{ maintenance: MaintenanceView }>(response)).maintenance
}

async function change(
  nowMs: number,
  id: string,
  action: "extend" | "reschedule" | "complete" | "cancel",
  body: Record<string, unknown>
): Promise<Response> {
  return adminCall(handleAdminRoutes, {
    keys,
    nowMs,
    method: "POST",
    path: `/admin/maintenance/${id}/${action}`,
    body: { operationId: operationId(action), ...body },
  })
}

async function advanceAt(nowMs: number): Promise<void> {
  const job = await jobAt("aggregate", nowMs)
  await advanceMaintenance(job)
  await baseEnv.DB.prepare(
    "UPDATE leases SET owner = NULL, expires_at = 0 WHERE job = 'aggregate'"
  ).run()
}

describe("exclusion math", () => {
  it("excludes nothing for cancelled or non-excluding windows and trims early completion", () => {
    const facts = {
      state: "scheduled" as const,
      startsAtMs: T0,
      endsAtMs: T0 + HOUR,
      actualEndAtMs: null,
      exclude: true,
    }
    expect(exclusionWindow(facts)).toEqual({
      startMinute: T0 / MINUTE,
      endMinute: (T0 + HOUR) / MINUTE,
    })
    expect(exclusionWindow({ ...facts, state: "cancelled" })).toBeNull()
    expect(exclusionWindow({ ...facts, exclude: false })).toBeNull()
    // Completed early at 10:20:30: excluded through the 10:20 minute only.
    expect(
      exclusionWindow({ ...facts, state: "completed", actualEndAtMs: T0 + 20 * MINUTE + 30_000 })
    ).toEqual({
      startMinute: T0 / MINUTE,
      endMinute: (T0 + 21 * MINUTE) / MINUTE,
    })
    // Completed late (after awaiting confirmation): still the planned end.
    expect(exclusionWindow({ ...facts, state: "completed", actualEndAtMs: T0 + 3 * HOUR })).toEqual(
      {
        startMinute: T0 / MINUTE,
        endMinute: (T0 + HOUR) / MINUTE,
      }
    )
  })

  it("marks only changed minutes that already started", () => {
    const before = { startMinute: 100, endMinute: 200 }
    expect(changedPastMinutes(before, { startMinute: 100, endMinute: 300 }, 150 * MINUTE)).toEqual(
      []
    )
    expect(changedPastMinutes(before, { startMinute: 100, endMinute: 120 }, 150 * MINUTE)).toEqual([
      { startMinute: 120, endMinute: 151 },
    ])
    expect(changedPastMinutes(before, null, 250 * MINUTE)).toEqual([
      { startMinute: 100, endMinute: 200 },
    ])
  })
})

describe("maintenance lifecycle", () => {
  beforeEach(async () => {
    await resetOwnerE()
    resetAccessKeyCache()
    vi.spyOn(globalThis, "fetch").mockImplementation(jwksFetch([keys]))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("validates the schedule: minute-aligned, not in the past, bounded", async () => {
    expect((await schedule(T0, T0 - MINUTE, T0 + HOUR)).status).toBe(400)
    expect((await schedule(T0, T0 + 30_000, T0 + HOUR)).status).toBe(400)
    expect((await schedule(T0, T0 + HOUR, T0 + HOUR)).status).toBe(400)
    expect((await schedule(T0, T0 + HOUR, T0 + 40 * 24 * HOUR)).status).toBe(400)
    // The current minute is allowed even after its first second.
    const ok = await schedule(T0 + 20_000, T0, T0 + HOUR)
    expect(ok.status).toBe(201)
    expect(await count("notification_events", "kind = 'maintenance.scheduled'")).toBe(1)
    // Starting in the current minute affects an already-started slot.
    expect(await count("dirty_hours")).toBe(1)
  })

  it("starts, waits for confirmation at the planned end, and records the actual end separately", async () => {
    const window = await scheduled(T0, T0 + HOUR, T0 + 2 * HOUR)
    expect(await activeMaintenanceComponents(baseEnv, T0)).toEqual(new Set())

    await advanceAt(T0 + HOUR)
    expect(await activeMaintenanceComponents(baseEnv, T0 + HOUR)).toEqual(new Set(["relayData"]))
    await advanceAt(T0 + HOUR + MINUTE)
    expect(await count("notification_events", "kind = 'maintenance.started'")).toBe(1)

    await advanceAt(T0 + 2 * HOUR + 5 * MINUTE)
    const [view] = await loadMaintenanceForSnapshot(baseEnv, T0 + 2 * HOUR + 5 * MINUTE)
    expect(view).toMatchObject({ id: window.id, state: "awaiting_confirmation", actualEndAt: null })
    // Exclusion stops at the planned end, not "until someone confirms".
    const windows = await loadExclusionWindows(baseEnv, T0, T0 + 4 * HOUR)
    expect(windows.relayData).toEqual([
      { startMinute: (T0 + HOUR) / MINUTE, endMinute: (T0 + 2 * HOUR) / MINUTE },
    ])
    expect(windows.signalingHttp).toEqual([])

    const completed = await change(T0 + 3 * HOUR, window.id, "complete", {
      expectedRevision: view!.revision,
      message: { en: "Done." },
    })
    expect(completed.status).toBe(200)
    const done = (await readJson<{ maintenance: MaintenanceView }>(completed)).maintenance
    expect(done).toMatchObject({
      state: "completed",
      endsAt: iso(T0 + 2 * HOUR),
      actualEndAt: iso(T0 + 3 * HOUR),
    })
    expect(done.updates.map((update) => update.kind)).toEqual([
      "scheduled",
      "started",
      "awaiting_confirmation",
      "completed",
    ])
    expect(await count("notification_events", "kind = 'maintenance.ended'")).toBe(1)
    // No awaiting-confirmation mail.
    expect(await count("notification_events")).toBe(3)
  })

  it("unions overlapping windows instead of double-excluding", async () => {
    await scheduled(T0, T0 + HOUR, T0 + 3 * HOUR)
    await scheduled(T0, T0 + 2 * HOUR, T0 + 4 * HOUR, ["relayData", "signalingAuth"])
    const windows = await loadExclusionWindows(baseEnv, T0, T0 + 5 * HOUR)
    expect(windows.relayData).toHaveLength(2)
    const merged = mergeMinuteWindows(windows.relayData)
    expect(excludedMinuteCount(T0 / MINUTE, (T0 + 5 * HOUR) / MINUTE, merged)).toBe(180)
    expect(windows.signalingAuth).toEqual([
      { startMinute: (T0 + 2 * HOUR) / MINUTE, endMinute: (T0 + 4 * HOUR) / MINUTE },
    ])
  })

  it("extends an in-progress window with one change notice and no rebuild of future minutes", async () => {
    const window = await scheduled(T0, T0, T0 + HOUR)
    await advanceAt(T0 + MINUTE)
    const before = await count("dirty_hours")
    const response = await change(T0 + 10 * MINUTE, window.id, "extend", {
      expectedRevision: 2,
      endsAt: iso(T0 + 2 * HOUR),
    })
    expect(response.status).toBe(200)
    expect((await readJson<{ maintenance: MaintenanceView }>(response)).maintenance).toMatchObject({
      state: "in_progress",
      endsAt: iso(T0 + 2 * HOUR),
      revision: 3,
    })
    expect(await count("notification_events", "kind = 'maintenance.changed'")).toBe(1)
    expect(await count("dirty_hours")).toBe(before)
    const audit = await baseEnv.DB.prepare(
      "SELECT detail_json FROM audit_events WHERE action = 'maintenance.extend'"
    ).first<{ detail_json: string }>()
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ pastEdit: false })

    const stale = await change(T0 + 11 * MINUTE, window.id, "extend", {
      expectedRevision: 2,
      endsAt: iso(T0 + 3 * HOUR),
    })
    expect(stale.status).toBe(409)
    expect(await readJson(stale)).toMatchObject({ code: "revision_conflict", currentRevision: 3 })
  })

  it("audits a past edit and marks the affected elapsed hours dirty", async () => {
    const window = await scheduled(T0, T0, T0 + 3 * HOUR)
    await advanceAt(T0 + MINUTE)
    await baseEnv.DB.prepare("DELETE FROM dirty_hours").run()
    // At 12:30, shorten the window to end at 11:00: 11:00–12:30 lose their exclusion.
    const response = await change(T0 + 2 * HOUR + 30 * MINUTE, window.id, "extend", {
      expectedRevision: 2,
      endsAt: iso(T0 + HOUR),
    })
    expect(response.status).toBe(200)
    expect((await readJson<{ maintenance: MaintenanceView }>(response)).maintenance.state).toBe(
      "awaiting_confirmation"
    )
    const hours = await baseEnv.DB.prepare("SELECT hour FROM dirty_hours ORDER BY hour").all<{
      hour: number
    }>()
    expect(hours.results.map((row) => row.hour)).toEqual([
      (T0 + HOUR) / HOUR,
      (T0 + 2 * HOUR) / HOUR,
    ])
    const audit = await baseEnv.DB.prepare(
      "SELECT detail_json FROM audit_events WHERE action = 'maintenance.extend'"
    ).first<{ detail_json: string }>()
    expect(JSON.parse(audit!.detail_json)).toMatchObject({
      pastEdit: true,
      previousEndsAt: iso(T0 + 3 * HOUR),
      endsAt: iso(T0 + HOUR),
    })
  })

  it("trims and rebuilds exclusions when completed early", async () => {
    const window = await scheduled(T0, T0, T0 + 3 * HOUR)
    await advanceAt(T0 + MINUTE)
    await baseEnv.DB.prepare("DELETE FROM dirty_hours").run()
    const response = await change(T0 + 30 * MINUTE, window.id, "complete", { expectedRevision: 2 })
    expect(response.status).toBe(200)
    const windows = await loadExclusionWindows(baseEnv, T0, T0 + 4 * HOUR)
    expect(windows.relayData).toEqual([
      { startMinute: T0 / MINUTE, endMinute: (T0 + 30 * MINUTE) / MINUTE },
    ])
    // Only the already-started current minute (10:30) lost its exclusion;
    // the trimmed future minutes need no rebuild.
    const hours = await baseEnv.DB.prepare("SELECT hour FROM dirty_hours").all<{ hour: number }>()
    expect(hours.results.map((row) => row.hour)).toEqual([T0 / HOUR])
  })

  it("cancels only before the start and reschedules only scheduled windows", async () => {
    const window = await scheduled(T0, T0 + HOUR, T0 + 2 * HOUR)
    const moved = await change(T0 + MINUTE, window.id, "reschedule", {
      expectedRevision: 1,
      startsAt: iso(T0 + 3 * HOUR),
      endsAt: iso(T0 + 4 * HOUR),
      message: { en: "Moved by two hours." },
    })
    expect(moved.status).toBe(200)
    const intoPast = await change(T0 + MINUTE, window.id, "reschedule", {
      expectedRevision: 2,
      startsAt: iso(T0 - HOUR),
      endsAt: iso(T0),
    })
    expect(intoPast.status).toBe(400)
    const cancelled = await change(T0 + 2 * MINUTE, window.id, "cancel", { expectedRevision: 2 })
    expect(cancelled.status).toBe(200)
    expect((await loadExclusionWindows(baseEnv, T0, T0 + 5 * HOUR)).relayData).toEqual([])
    expect(await count("notification_events", "kind = 'maintenance.ended'")).toBe(1)

    const started = await scheduled(T0, T0, T0 + HOUR)
    await advanceAt(T0 + MINUTE)
    expect(
      (await change(T0 + 2 * MINUTE, started.id, "cancel", { expectedRevision: 2 })).status
    ).toBe(409)
    expect(
      (
        await change(T0 + 2 * MINUTE, started.id, "reschedule", {
          expectedRevision: 2,
          startsAt: iso(T0 + HOUR),
          endsAt: iso(T0 + 2 * HOUR),
        })
      ).status
    ).toBe(409)
    expect(
      (await change(T0 + 2 * MINUTE, "mnt_missing", "cancel", { expectedRevision: 1 })).status
    ).toBe(404)
  })

  it("does not advance windows once the lease is lost", async () => {
    await scheduled(T0, T0, T0 + HOUR)
    const job = await jobAt("aggregate", T0 + MINUTE)
    await stealLease(job.lease)
    await advanceMaintenance(job)
    expect(await count("maintenance", "state = 'scheduled'")).toBe(1)
    expect(await count("notification_events", "kind = 'maintenance.started'")).toBe(0)
  })

  it("shows recent finished windows in the snapshot but not old ones, and lists all for operators", async () => {
    const old = await scheduled(T0, T0 + HOUR, T0 + 2 * HOUR)
    await change(T0 + MINUTE, old.id, "cancel", { expectedRevision: 1 })
    const upcoming = await scheduled(T0, T0 + 5 * HOUR, T0 + 6 * HOUR)
    const later = T0 + 8 * 24 * HOUR
    const snapshot = await loadMaintenanceForSnapshot(baseEnv, later)
    expect(snapshot.map((view) => view.id)).toEqual([upcoming.id])
    expect(
      (await loadMaintenanceForSnapshot(baseEnv, T0 + 2 * MINUTE)).map((view) => view.id).sort()
    ).toEqual([old.id, upcoming.id].sort())
    const list = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: later,
      method: "GET",
      path: "/admin/maintenance?limit=1",
    })
    const page = await readJson<{ maintenance: MaintenanceView[]; nextCursor: string | null }>(list)
    expect(page.maintenance).toHaveLength(1)
    expect(page.nextCursor).not.toBeNull()
    const rest = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: later,
      method: "GET",
      path: `/admin/maintenance?limit=1&cursor=${page.nextCursor}`,
    })
    expect((await readJson<{ maintenance: MaintenanceView[] }>(rest)).maintenance).toHaveLength(1)
  })
})
