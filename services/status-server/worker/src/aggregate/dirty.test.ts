import { beforeEach, describe, expect, it } from "vitest"

import { resetCore, testEnv } from "../../test/helpers"
import {
  hoursCovering,
  markHoursDirtyStatements,
  markMinuteRangeDirtyStatements,
  markMinutesDirty,
} from "./dirty"

const db = () => testEnv.DB

async function dirty() {
  return (
    await db()
      .prepare("SELECT hour, seq FROM dirty_hours ORDER BY hour")
      .all<{ hour: number; seq: number }>()
  ).results
}

beforeEach(async () => {
  await resetCore()
})

describe("dirty-hour marking", () => {
  it("covers every hour a minute range touches", () => {
    expect(hoursCovering(60, 120)).toEqual([1])
    expect(hoursCovering(59, 121)).toEqual([0, 1, 2])
    expect(hoursCovering(10, 10)).toEqual([])
  })

  it("marks a long range with two statements and one sequence bump", async () => {
    const statements = markMinuteRangeDirtyStatements(db(), 0, 30 * 24 * 60)
    expect(statements).toHaveLength(2)
    await db().batch(statements)
    const rows = await dirty()
    expect(rows).toHaveLength(720)
    expect(new Set(rows.map((row) => row.seq))).toEqual(new Set([1]))
  })

  it("re-marks an existing hour with the newer sequence", async () => {
    await markMinutesDirty(db(), 0, 60)
    await db().batch(markHoursDirtyStatements(db(), [0]))
    expect(await dirty()).toEqual([{ hour: 0, seq: 2 }])
    expect(markMinuteRangeDirtyStatements(db(), 5, 5)).toEqual([])
  })
})
