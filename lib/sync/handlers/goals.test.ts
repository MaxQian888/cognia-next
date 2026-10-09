/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import {
  countGoalEvents,
  EVENTS_PER_GOAL_CAP,
  latestJudgeReasons,
  listGoalEvents,
} from "@/lib/db/goals"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { Goal, GoalEvent } from "@/types/goal"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"
import {
  applyGoalEventRows,
  deleteGoalRows,
  projectGoalEventForSync,
  syncGoalEvents,
  syncGoals,
} from "./goals"

function goal(id: string): Goal {
  return { id, sessionId: "s1", createdAt: 1, updatedAt: 1 } as unknown as Goal
}

function event(id: string, goalId: string, ts: number): GoalEvent {
  return { id, goalId, kind: "turn_started", ts, payload: { kind: "turn_started", turnNumber: ts } }
}

function makeTransport(rows: Goal[], deleted_ids: string[] = [], next_since = 1): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncGoals", () => {
  it("calls sync_pull with table=goals + the given cursor", async () => {
    const tx = makeTransport([], [], 7)
    const out = await syncGoals(tx, { since: 99 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "goals",
      since: 99,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(7)
  })

  it("persists goal upserts into Dexie", async () => {
    const rows = [{ id: "g1" } as unknown as Goal, { id: "g2" } as unknown as Goal]
    const out = await syncGoals(makeTransport(rows), { since: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(2)
  })
})

describe("syncGoals deletion", () => {
  beforeEach(async () => {
    await Promise.all([getDb().chatGoals.clear(), getDb().chatGoalEvents.clear()])
  })

  it("drops a tombstoned goal together with its mirrored events, leaving other goals' events", async () => {
    await getDb().chatGoals.bulkPut([goal("g-gone"), goal("g-kept")])
    await getDb().chatGoalEvents.bulkPut([
      event("e1", "g-gone", 1),
      event("e2", "g-gone", 2),
      event("e3", "g-kept", 3),
    ])
    const out = await syncGoals(makeTransport([], ["g-gone"], 9), { since: 5 })
    expect(out.ok).toBe(true)
    expect(await getDb().chatGoals.get("g-gone")).toBeUndefined()
    expect(await getDb().chatGoals.get("g-kept")).toBeDefined()
    expect((await getDb().chatGoalEvents.toArray()).map((row) => row.id)).toEqual(["e3"])
  })

  it("is a no-op for a tombstone whose goal never reached this device", async () => {
    await getDb().chatGoalEvents.put(event("e1", "g-kept", 1))
    await deleteGoalRows([])
    await deleteGoalRows(["g-unknown"])
    expect(await getDb().chatGoalEvents.count()).toBe(1)
  })
})

describe("syncGoalEvents", () => {
  beforeEach(async () => {
    await getDb().chatGoalEvents.clear()
  })

  function eventTransport(
    rows: GoalEvent[],
    next_since = 1,
    next_cursor = '{"version":1}'
  ): Transport {
    return {
      call: jest.fn(async () => ({
        rows,
        deleted_ids: [],
        next_since,
        next_cursor,
      })) as unknown as Transport["call"],
      subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
    }
  }

  it("pulls table=goalEvents with the paged cursor and persists the rows", async () => {
    const tx = eventTransport([event("e1", "g1", 10), event("e2", "g1", 11)], 11, "c1")
    const out = await syncGoalEvents(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "goalEvents",
      since: 0,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
      cursor: "",
    })
    expect(out.ok && out.result).toMatchObject({ applied: 2, nextSince: 11, nextCursor: "c1" })
    expect(await listGoalEvents("g1")).toEqual([event("e2", "g1", 11), event("e1", "g1", 10)])
  })

  it("re-applying the same page leaves one copy of each event", async () => {
    const rows = [event("e1", "g1", 10), event("e2", "g1", 11)]
    await syncGoalEvents(eventTransport(rows), { since: 0 })
    await syncGoalEvents(eventTransport(rows), { since: 0 })
    expect(await getDb().chatGoalEvents.count()).toBe(2)
  })

  it("trims each goal a page touched to the host's per-goal cap", async () => {
    const cap = EVENTS_PER_GOAL_CAP
    const rows = Array.from({ length: cap + 2 }, (_, i) => event(`e${i}`, "g-busy", i + 1))
    await getDb().chatGoalEvents.put(event("quiet", "g-quiet", 1))
    await applyGoalEventRows(rows)
    expect(await countGoalEvents("g-busy")).toBe(cap)
    const oldest = await getDb()
      .chatGoalEvents.where("[goalId+ts]")
      .between(["g-busy", -Infinity], ["g-busy", Infinity])
      .first()
    // The two oldest went, exactly as the host's own prune drops them.
    expect(oldest?.id).toBe("e2")
    expect(await countGoalEvents("g-quiet")).toBe(1)
  })

  it("feeds the judge notes and the detail's reads on the phone", async () => {
    await applyGoalEventRows([
      event("e1", "g1", 10),
      {
        id: "e2",
        goalId: "g1",
        kind: "judge_evaluated",
        ts: 11,
        payload: { kind: "judge_evaluated", done: false, reason: "two tests left", judgeTokens: 4 },
      },
    ])
    expect(await latestJudgeReasons(["g1", "g2"])).toEqual(new Map([["g1", "two tests left"]]))
    expect(await countGoalEvents("g1")).toBe(2)
  })
})

describe("projectGoalEventForSync", () => {
  it("empties the judge's unparsed output and leaves every other field alone", () => {
    const failed: GoalEvent = {
      id: "e1",
      goalId: "g1",
      kind: "judge_parse_failed",
      ts: 5,
      payload: { kind: "judge_parse_failed", raw: "{not json", failureCount: 2 },
    }
    expect(projectGoalEventForSync(failed)).toEqual({
      ...failed,
      payload: { kind: "judge_parse_failed", raw: "", failureCount: 2 },
    })
    // The stored row is not mutated.
    expect(failed.payload).toMatchObject({ raw: "{not json" })
  })

  it("passes every other kind through unchanged", () => {
    const judged: GoalEvent = {
      id: "e2",
      goalId: "g1",
      kind: "judge_evaluated",
      ts: 6,
      payload: { kind: "judge_evaluated", done: true, reason: "all green", judgeTokens: 3 },
    }
    expect(projectGoalEventForSync(judged)).toBe(judged)
  })
})
