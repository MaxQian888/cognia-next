/** @jest-environment jsdom */

import {
  claimQueuedOnlineEvals,
  pruneOnlineEvalData,
  deleteOnlinePolicy,
  enqueueOnlineEval,
  listEnabledOnlinePolicies,
  listObservationsForTrace,
  listOnlinePolicies,
  listRecentObservations,
  putObservations,
  putOnlinePolicy,
  readBudget,
  reserveOnlineEvalBudget,
  settleOnlineEvalBudget,
  setOnlineEvalState,
  skipOnlineEval,
} from "./eval-online"
import { budgetDayKey, queueDedupeKey, type EvalOnlinePolicyRow } from "./eval-online-types"
import { buildObservation, type EvalObservationV1 } from "@cognia/eval-core"
import { getDb } from "./schema"
import { createDbTestFixture, DB_TEST_TIMEOUT_MS } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().evalObservations.clear()
  await getDb().evalOnlinePolicies.clear()
  await getDb().evalOnlineQueue.clear()
  await getDb().evalOnlineBudget.clear()
}, DB_TEST_TIMEOUT_MS)

function policy(overrides: Partial<EvalOnlinePolicyRow> = {}): EvalOnlinePolicyRow {
  return {
    schema: "cognia-online-eval-policy/v1",
    id: "p1",
    versionId: "p1@1",
    name: "Chat quality",
    enabled: true,
    shadow: false,
    selector: {},
    deterministicEvaluatorVersionIds: ["det@1"],
    judgeEvaluatorVersionIds: [],
    sampling: { judgeRate: 0.05, judgeDailyMax: 200 },
    budget: { dailyUsdCap: 5 },
    escalation: {
      thresholdBand: 0.1,
      onEvaluatorConflict: true,
      onJudgeParseFailure: true,
      onNegativeFeedback: true,
    },
    workspaceId: "w1",
    enabledFlag: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function observation(id: string, traceId: string): EvalObservationV1 {
  return buildObservation({
    id,
    scope: { traceId },
    origin: "online",
    evaluatorVersionId: "det@1",
    score: {
      scorerId: "tool-selection",
      dimension: "tool-use",
      status: "scored",
      value: 1,
      passed: true,
    },
    createdAt: 10,
  })
}

describe("policies", () => {
  it("derives enabledFlag from enabled so Dexie can index it", async () => {
    await putOnlinePolicy(policy({ enabled: false, enabledFlag: 1 }))
    const [stored] = await listOnlinePolicies("w1")
    expect(stored.enabledFlag).toBe(0)
  })

  it("lists only the enabled policies for a workspace", async () => {
    await putOnlinePolicy(policy({ id: "on" }))
    await putOnlinePolicy(policy({ id: "off", enabled: false }))
    await putOnlinePolicy(policy({ id: "elsewhere", workspaceId: "w2" }))
    const enabled = await listEnabledOnlinePolicies("w1")
    expect(enabled.map((row) => row.id)).toEqual(["on"])
  })

  it("deletes a policy", async () => {
    await putOnlinePolicy(policy())
    await deleteOnlinePolicy("p1")
    expect(await listOnlinePolicies()).toEqual([])
  })
})

describe("queue", () => {
  it("dedupes a trace re-offered under the same policy version", async () => {
    // A retry, a second transport, or a replayed buffer must resolve to the
    // SAME work item — otherwise the trace is scored, and charged, twice.
    const first = await enqueueOnlineEval({
      id: "q1",
      policyId: "p1",
      policyVersionId: "p1@1",
      traceId: "t1",
      now: 1,
    })
    const second = await enqueueOnlineEval({
      id: "q2",
      policyId: "p1",
      policyVersionId: "p1@1",
      traceId: "t1",
      now: 2,
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.row.id).toBe("q1")
    expect(await getDb().evalOnlineQueue.count()).toBe(1)
    expect(first.row.dedupeKey).toBe(queueDedupeKey("p1@1", "t1"))
  })

  it("treats a NEW policy version as new work on the same trace", async () => {
    await enqueueOnlineEval({
      id: "q1",
      policyId: "p1",
      policyVersionId: "p1@1",
      traceId: "t1",
      now: 1,
    })
    const next = await enqueueOnlineEval({
      id: "q2",
      policyId: "p1",
      policyVersionId: "p1@2",
      traceId: "t1",
      now: 2,
    })
    expect(next.created).toBe(true)
  })

  it("claims queued rows oldest-first and leaves settled ones alone", async () => {
    await enqueueOnlineEval({
      id: "q1",
      policyId: "p1",
      policyVersionId: "p1@1",
      traceId: "t1",
      now: 5,
    })
    await enqueueOnlineEval({
      id: "q2",
      policyId: "p1",
      policyVersionId: "p1@1",
      traceId: "t2",
      now: 1,
    })
    await setOnlineEvalState("q1", "done")
    const claimed = await claimQueuedOnlineEvals(10)
    expect(claimed.map((row) => row.id)).toEqual(["q2"])
  })

  it("records WHY a trace was skipped instead of dropping or retrying it", async () => {
    await enqueueOnlineEval({
      id: "q1",
      policyId: "p1",
      policyVersionId: "p1@1",
      traceId: "t1",
      now: 1,
    })
    await skipOnlineEval("q1", "skipped-budget")
    const row = await getDb().evalOnlineQueue.get("q1")
    expect(row?.state).toBe("skipped")
    expect(row?.skipReason).toBe("skipped-budget")
    // Terminal: a budget refusal must not come back around as queued work.
    expect(await claimQueuedOnlineEvals(10)).toEqual([])
  })
})

describe("budget ledger", () => {
  it("starts a day at zero without writing a row", async () => {
    const row = await readBudget("p1", Date.parse("2026-08-30T10:00:00Z"))
    expect(row).toMatchObject({ spentUsd: 0, reservedUsd: 0, judgedCount: 0, day: "2026-08-30" })
    expect(await getDb().evalOnlineBudget.count()).toBe(0)
  })

  it("reserves up to the cap and refuses the request that would breach it", async () => {
    const now = Date.parse("2026-08-30T10:00:00Z")
    expect(await reserveOnlineEvalBudget("p1", 4, 5, now)).toBe(true)
    // 4 + 1.5 > 5 — refused BEFORE the call, not apologised for after.
    expect(await reserveOnlineEvalBudget("p1", 1.5, 5, now)).toBe(false)
    expect(await reserveOnlineEvalBudget("p1", 1, 5, now)).toBe(true)
    expect((await readBudget("p1", now)).reservedUsd).toBe(5)
  })

  it("counts a concurrent reservation, so two callers cannot both fit", async () => {
    const now = Date.parse("2026-08-30T10:00:00Z")
    await reserveOnlineEvalBudget("p1", 3, 5, now)
    expect(await reserveOnlineEvalBudget("p1", 3, 5, now)).toBe(false)
  })

  it("releases the reservation and records actual spend on settle", async () => {
    const now = Date.parse("2026-08-30T10:00:00Z")
    await reserveOnlineEvalBudget("p1", 2, 5, now)
    await settleOnlineEvalBudget("p1", 2, 0.4, true, now)
    const row = await readBudget("p1", now)
    expect(row.reservedUsd).toBe(0)
    expect(row.spentUsd).toBe(0.4)
    expect(row.judgedCount).toBe(1)
  })

  it("charges a FAILED call that still cost money", async () => {
    // Releasing without charging leaks a little of the cap on every error.
    const now = Date.parse("2026-08-30T10:00:00Z")
    await reserveOnlineEvalBudget("p1", 2, 5, now)
    await settleOnlineEvalBudget("p1", 2, 0.25, false, now)
    const row = await readBudget("p1", now)
    expect(row.spentUsd).toBe(0.25)
    expect(row.judgedCount).toBe(0)
  })

  it("keeps a separate ledger per UTC day", async () => {
    const monday = Date.parse("2026-08-30T23:00:00Z")
    const tuesday = Date.parse("2026-08-31T01:00:00Z")
    await reserveOnlineEvalBudget("p1", 4, 5, monday)
    expect(budgetDayKey(monday)).not.toBe(budgetDayKey(tuesday))
    // Yesterday's spend must not consume today's cap.
    expect(await reserveOnlineEvalBudget("p1", 4, 5, tuesday)).toBe(true)
  })
})

describe("observations", () => {
  it("stores and reads back by trace", async () => {
    await putObservations([observation("o1", "t1"), observation("o2", "t2")])
    const forTrace = await listObservationsForTrace("t1")
    expect(forTrace.map((row) => row.id)).toEqual(["o1"])
  })

  it("is a no-op on an empty write rather than opening a transaction", async () => {
    await putObservations([])
    expect(await getDb().evalObservations.count()).toBe(0)
  })

  it("reads recent observations by origin", async () => {
    await putObservations([observation("o1", "t1")])
    expect((await listRecentObservations("online", 0)).map((row) => row.id)).toEqual(["o1"])
    expect(await listRecentObservations("offline", 0)).toEqual([])
    expect(await listRecentObservations("online", 100)).toEqual([])
  })
})

describe("pruneOnlineEvalData", () => {
  const DAY = 86_400_000

  it("keeps unsettled queue work however old it is", async () => {
    // Age is not a reason to forget something that has not finished; deleting
    // a `queued` row because it is old drops the work silently.
    await enqueueOnlineEval({
      id: "stale-queued",
      policyId: "p1",
      policyVersionId: "p1@1",
      traceId: "t-old",
      now: 0,
    })
    await enqueueOnlineEval({
      id: "stale-done",
      policyId: "p1",
      policyVersionId: "p1@1",
      traceId: "t-done",
      now: 0,
    })
    await setOnlineEvalState("stale-done", "done", {}, 0)

    const removed = await pruneOnlineEvalData({
      observationsBefore: 10 * DAY,
      queueBefore: 10 * DAY,
      budgetBefore: 10 * DAY,
    })

    expect(removed).toBe(1)
    expect(await getDb().evalOnlineQueue.get("stale-queued")).toBeDefined()
    expect(await getDb().evalOnlineQueue.get("stale-done")).toBeUndefined()
  })

  it("prunes observations and budget rows past their windows, keeping fresh ones", async () => {
    await putObservations([
      { ...observation("old", "t1"), createdAt: 1 },
      { ...observation("fresh", "t2"), createdAt: 20 * DAY },
    ])
    await reserveOnlineEvalBudget("p1", 1, 5, 1)
    await reserveOnlineEvalBudget("p1", 1, 5, 20 * DAY)

    await pruneOnlineEvalData({
      observationsBefore: 10 * DAY,
      queueBefore: 10 * DAY,
      budgetBefore: 10 * DAY,
    })

    expect((await getDb().evalObservations.toArray()).map((row) => row.id)).toEqual(["fresh"])
    expect((await getDb().evalOnlineBudget.toArray()).map((row) => row.day)).toEqual([
      budgetDayKey(20 * DAY),
    ])
  })
})
