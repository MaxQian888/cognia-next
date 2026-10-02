import { beforeEach, describe, expect, it } from "vitest"

import { DAY_MS, HOUR_MS, type ComponentId } from "../../../../../lib/status/contract"
import type { MinuteWindow } from "../../../../../lib/status/derive"
import { lease, resetCore, testEnv } from "../../test/helpers"
import { leaseGuard } from "../platform/lease"
import { markMinutesDirty } from "./dirty"
import {
  computeRollup,
  mergeExclusions,
  parseRollup,
  rebuildDirtyHours,
  sumRollups,
  type ExclusionWindows,
  type SlotRow,
} from "./rollup"

const NO_WINDOWS: ExclusionWindows = { signalingHttp: [], signalingAuth: [], relayData: [] }

function slot(
  minute: number,
  http: SlotRow["http"],
  auth: SlotRow["auth"],
  data: SlotRow["data"]
): SlotRow {
  return {
    minute,
    http,
    auth,
    data,
    http_ms: http === "pass" ? 40 : null,
    auth_ms: auth === "pass" ? 900 : null,
    data_ms: data === "pass" ? 300 : null,
  }
}

function maintenanceModule(windows: ExclusionWindows = NO_WINDOWS) {
  return {
    loadExclusionWindows: async () => windows,
  }
}

describe("computeRollup", () => {
  it("counts per component and joins the overall minute", () => {
    const rollup = computeRollup(
      [
        slot(0, "pass", "pass", "pass"),
        slot(1, "pass", "fail", "unknown"),
        slot(2, "pass", "pass", "unknown"),
      ],
      mergeExclusions(NO_WINDOWS),
      true
    )
    expect(rollup.c.signalingHttp).toMatchObject({ p: 3, f: 0 })
    expect(rollup.c.signalingAuth).toMatchObject({ p: 2, f: 1 })
    expect(rollup.c.relayData).toMatchObject({ p: 1, f: 0 })
    // minute 1 fails (auth failed), minute 2 unknown (data not measured)
    expect(rollup.o).toEqual({ p: 1, f: 1, xp: 0, xf: 0 })
  })

  it("puts only successful attempts in the latency histogram", () => {
    const rollup = computeRollup(
      [slot(0, "pass", "fail", "unknown")],
      mergeExclusions(NO_WINDOWS),
      true
    )
    expect(rollup.c.signalingHttp.h!.reduce((sum, count) => sum + count, 0)).toBe(1)
    expect(rollup.c.signalingAuth.h!.reduce((sum, count) => sum + count, 0)).toBe(0)
  })

  it("counts excluded minutes per component and unions windows for the overall series", () => {
    const windows: ExclusionWindows = {
      signalingHttp: [],
      signalingAuth: [{ startMinute: 1, endMinute: 2 }],
      relayData: [{ startMinute: 1, endMinute: 3 }],
    }
    const rollup = computeRollup(
      [
        slot(0, "pass", "fail", "unknown"),
        slot(1, "pass", "fail", "unknown"),
        slot(2, "pass", "pass", "fail"),
      ],
      mergeExclusions(windows),
      false
    )
    expect(rollup.c.signalingAuth).toMatchObject({ f: 2, xf: 1 })
    expect(rollup.c.relayData).toMatchObject({ f: 1, xf: 1 })
    expect(rollup.o).toEqual({ p: 0, f: 3, xp: 0, xf: 2 })
  })

  it("sums rollups by counts and merges histograms", () => {
    const one = computeRollup([slot(0, "pass", "pass", "pass")], mergeExclusions(NO_WINDOWS), true)
    const two = computeRollup([slot(1, "fail", "pass", "pass")], mergeExclusions(NO_WINDOWS), true)
    const total = sumRollups([one, two], true)
    expect(total.c.signalingHttp).toMatchObject({ p: 1, f: 1 })
    expect(total.c.signalingAuth.h!.reduce((sum, count) => sum + count, 0)).toBe(2)
    expect(parseRollup(JSON.stringify(total))).toEqual(total)
    expect(parseRollup('{"v":99}')).toBeNull()
  })
})

describe("rebuildDirtyHours", () => {
  const db = () => testEnv.DB
  const nowMs = Date.now()
  const hour = Math.floor(nowMs / HOUR_MS) - 1

  async function insertSlot(minute: number, http: string, auth: string, data: string) {
    await db()
      .prepare(
        `INSERT INTO reference_slots (minute, reference_revision, probe_id, run_id, http, auth, data, http_ms, auth_ms, data_ms, received_at)
         VALUES (?, 1, 'p', ?, ?, ?, ?, 50, 50, 50, 0)`
      )
      .bind(minute, `run_${minute}`, http, auth, data)
      .run()
  }

  beforeEach(async () => {
    await resetCore()
  })

  it("rebuilds a dirty hour and its day, then clears the mark", async () => {
    await insertSlot(hour * 60, "pass", "pass", "pass")
    await insertSlot(hour * 60 + 1, "pass", "fail", "unknown")
    await markMinutesDirty(db(), hour * 60, hour * 60 + 2)
    const job = { env: testEnv, lease: await lease("aggregate", nowMs), nowMs }
    const result = await rebuildDirtyHours(job, maintenanceModule())
    expect(result).toMatchObject({ rebuiltHours: 1, rebuiltDays: 1 })
    const hourly = await db()
      .prepare("SELECT rollup_json FROM hourly_rollups WHERE hour = ?")
      .bind(hour)
      .first<{ rollup_json: string }>()
    expect(parseRollup(hourly!.rollup_json)!.c.signalingAuth).toMatchObject({ p: 1, f: 1 })
    const daily = await db()
      .prepare("SELECT rollup_json FROM daily_rollups WHERE day = ?")
      .bind(Math.floor((hour * HOUR_MS) / DAY_MS))
      .first<{ rollup_json: string }>()
    expect(parseRollup(daily!.rollup_json)!.o).toEqual({ p: 1, f: 1, xp: 0, xf: 0 })
    expect(
      (await db().prepare("SELECT COUNT(*) AS n FROM dirty_hours").first<{ n: number }>())?.n
    ).toBe(0)
  })

  it("keeps a mark that was re-dirtied during the rebuild", async () => {
    await insertSlot(hour * 60, "pass", "pass", "pass")
    await markMinutesDirty(db(), hour * 60, hour * 60 + 1)
    const job = { env: testEnv, lease: await lease("aggregate", nowMs), nowMs }
    const racing = {
      loadExclusionWindows: async () => {
        // A late observation arrives while the rollup is being computed.
        await markMinutesDirty(db(), hour * 60, hour * 60 + 1)
        return NO_WINDOWS
      },
    }
    await rebuildDirtyHours(job, racing)
    expect(
      (await db().prepare("SELECT COUNT(*) AS n FROM dirty_hours").first<{ n: number }>())?.n
    ).toBe(1)
  })

  it("writes nothing once the lease is lost", async () => {
    await insertSlot(hour * 60, "pass", "pass", "pass")
    await markMinutesDirty(db(), hour * 60, hour * 60 + 1)
    const held = await lease("aggregate", nowMs)
    // Another runner takes over after expiry.
    await db()
      .prepare("UPDATE leases SET owner = 'other', fence = fence + 1 WHERE job = 'aggregate'")
      .run()
    expect(
      (
        await db()
          .prepare(`SELECT ${leaseGuard(held, nowMs).sql} AS held`)
          .bind(...leaseGuard(held, nowMs).params)
          .first<{ held: number }>()
      )?.held
    ).toBe(0)
    await rebuildDirtyHours({ env: testEnv, lease: held, nowMs }, maintenanceModule())
    expect(
      (await db().prepare("SELECT COUNT(*) AS n FROM hourly_rollups").first<{ n: number }>())?.n
    ).toBe(0)
    expect(
      (await db().prepare("SELECT COUNT(*) AS n FROM dirty_hours").first<{ n: number }>())?.n
    ).toBe(1)
  })

  it("drops marks older than slot retention instead of zeroing history", async () => {
    const ancient = Math.floor((nowMs - 120 * DAY_MS) / HOUR_MS)
    await db()
      .prepare(
        "INSERT INTO daily_rollups (day, source_seq, rollup_json, updated_at) VALUES (?, 1, ?, 0)"
      )
      .bind(Math.floor((ancient * HOUR_MS) / DAY_MS), '{"v":1}')
      .run()
    await markMinutesDirty(db(), ancient * 60, ancient * 60 + 1)
    const result = await rebuildDirtyHours(
      { env: testEnv, lease: await lease("aggregate", nowMs), nowMs },
      maintenanceModule()
    )
    expect(result.skippedHours).toBe(1)
    expect(
      (await db().prepare("SELECT rollup_json FROM daily_rollups").first<{ rollup_json: string }>())
        ?.rollup_json
    ).toBe('{"v":1}')
    expect(
      (await db().prepare("SELECT COUNT(*) AS n FROM dirty_hours").first<{ n: number }>())?.n
    ).toBe(0)
  })

  it("rebuilds an old hour together with its whole day", async () => {
    const oldHour = Math.floor((nowMs - 20 * DAY_MS) / HOUR_MS)
    const dayStartHour = Math.floor((oldHour * HOUR_MS) / DAY_MS) * 24
    await insertSlot(dayStartHour * 60 + 5, "fail", "fail", "unknown")
    await insertSlot(oldHour * 60, "pass", "pass", "pass")
    const windows: ExclusionWindows = {
      signalingHttp: [{ startMinute: dayStartHour * 60, endMinute: dayStartHour * 60 + 60 }],
      signalingAuth: [],
      relayData: [],
    }
    await markMinutesDirty(db(), oldHour * 60, oldHour * 60 + 1)
    const result = await rebuildDirtyHours(
      { env: testEnv, lease: await lease("aggregate", nowMs), nowMs },
      maintenanceModule(windows)
    )
    expect(result.rebuiltHours).toBe(24)
    const daily = await db()
      .prepare("SELECT rollup_json FROM daily_rollups WHERE day = ?")
      .bind(dayStartHour / 24)
      .first<{ rollup_json: string }>()
    const rollup = parseRollup(daily!.rollup_json)!
    expect(rollup.c.signalingHttp).toMatchObject({
      p: oldHour === dayStartHour ? 1 : 1,
      f: 1,
      xf: 1,
    })
  })
})

describe("mergeExclusions", () => {
  it("merges per component and unions for overall", () => {
    const windows: Record<ComponentId, MinuteWindow[]> = {
      signalingHttp: [{ startMinute: 0, endMinute: 10 }],
      signalingAuth: [{ startMinute: 5, endMinute: 15 }],
      relayData: [],
    }
    expect(mergeExclusions(windows).overall).toEqual([{ startMinute: 0, endMinute: 15 }])
  })
})
