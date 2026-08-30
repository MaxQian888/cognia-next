import { builtInEvaluatorVersionId, type OnlineEvalPolicyV1 } from "@cognia/eval-core"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalOnlineQueueRow } from "@/lib/db/eval-online-types"
import type { EvalObservationV1, JudgeSamplingDecision } from "@cognia/eval-core"
import type { EvalOnlineBudgetRow } from "@/lib/db/eval-online-types"
import {
  drainOnlineEvalQueue,
  JUDGE_COST_ESTIMATE_USD,
  type OnlineEvalWorkerDependencies,
} from "./worker"

function policy(overrides: Partial<OnlineEvalPolicyV1> = {}): OnlineEvalPolicyV1 {
  return {
    schema: "cognia-online-eval-policy/v1",
    id: "p1",
    versionId: "p1@1",
    name: "n",
    enabled: true,
    shadow: false,
    selector: {},
    deterministicEvaluatorVersionIds: [builtInEvaluatorVersionId("tool-redundancy")],
    judgeEvaluatorVersionIds: [],
    sampling: { judgeRate: 1, judgeDailyMax: 200 },
    budget: { dailyUsdCap: 5 },
    escalation: {
      thresholdBand: 0.1,
      onEvaluatorConflict: true,
      onJudgeParseFailure: true,
      onNegativeFeedback: true,
    },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function row(overrides: Partial<EvalOnlineQueueRow> = {}): EvalOnlineQueueRow {
  return {
    id: "q1",
    policyId: "p1",
    policyVersionId: "p1@1",
    traceId: "t1",
    dedupeKey: "p1@1::t1",
    state: "queued",
    reservedUsd: 0,
    attempts: 0,
    enqueuedAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function span(overrides: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return {
    id: "root",
    traceId: "t1",
    spanId: "root",
    sessionId: "s1",
    surface: "chat",
    operationName: "chat",
    providerName: "anthropic",
    startTime: 100,
    endTime: 200,
    status: "ok",
    ...overrides,
  } as AgentTraceSpan
}

function ledger(overrides: Partial<EvalOnlineBudgetRow> = {}): EvalOnlineBudgetRow {
  return {
    id: "p1::2026-08-30",
    policyId: "p1",
    day: "2026-08-30",
    spentUsd: 0,
    reservedUsd: 0,
    judgedCount: 0,
    updatedAt: 0,
    ...overrides,
  }
}

/**
 * Every dependency is typed by its implementation signature rather than a
 * `jest.Mock` generic, so `mock.calls[n][m]` stays a real tuple instead of the
 * empty one an argument-less `jest.fn()` infers.
 */
function harness(overrides: Partial<OnlineEvalWorkerDependencies> = {}) {
  const setState = jest.fn(
    async (
      _id: string,
      _state: EvalOnlineQueueRow["state"],
      _patch?: Partial<Pick<EvalOnlineQueueRow, "error" | "skipReason" | "attempts">>,
      _now?: number
    ) => undefined
  )
  const skip = jest.fn(
    async (_id: string, _reason: JudgeSamplingDecision, _now?: number) => undefined
  )
  const writeObservations = jest.fn(async (_rows: readonly EvalObservationV1[]) => undefined)
  const reserve = jest.fn(
    async (_policyId: string, _amount: number, _cap: number, _now?: number) => true
  )
  const settle = jest.fn(
    async (
      _policyId: string,
      _reserved: number,
      _actual: number,
      _judged: boolean,
      _now?: number
    ) => undefined
  )
  const budget = jest.fn(async (_policyId: string, _now?: number) => ledger())

  const deps: OnlineEvalWorkerDependencies = {
    claim: async () => [row()],
    policies: () => [policy()],
    loadSpans: async () => [span()],
    writeObservations,
    setState,
    skip,
    reserve,
    settle,
    budget,
    now: () => 1_000,
    newId: (parts: string) => `obs_${parts}`,
    ...overrides,
  }
  return { deps, setState, skip, writeObservations, reserve, settle, budget }
}

describe("drainOnlineEvalQueue", () => {
  it("returns immediately when nothing is queued", async () => {
    const { deps } = harness({ claim: async () => [] })
    expect(await drainOnlineEvalQueue(20, deps)).toMatchObject({ claimed: 0, evaluated: 0 })
  })

  it("settles every claimed row terminally — the only states retention can prune", async () => {
    // A row that never leaves `queued` can never be deleted, which turns the
    // queue into an unbounded table.
    const { deps, setState } = harness()
    const result = await drainOnlineEvalQueue(20, deps)
    expect(result.evaluated).toBe(1)
    const states = setState.mock.calls.map((call) => call[1])
    expect(states).toEqual(["running", "done"])
  })

  it("writes observations for the trace it evaluated", async () => {
    const { deps, writeObservations } = harness()
    await drainOnlineEvalQueue(20, deps)
    const written = writeObservations.mock.calls[0][0]
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ origin: "online" })
  })

  it("skips a row whose policy version is gone instead of judging it under another", async () => {
    // Answering under an edited policy would attribute a verdict to a version
    // that never asked the question.
    const { deps, skip } = harness({ policies: () => [policy({ versionId: "p1@2" })] })
    const result = await drainOnlineEvalQueue(20, deps)
    expect(result.skipped).toBe(1)
    expect(result.evaluated).toBe(0)
    expect(skip).toHaveBeenCalledWith("q1", "skipped-no-judge", 1_000)
  })

  it("marks a row failed rather than retrying it forever", async () => {
    // The trace will not change, so the same evaluator fails the same way; an
    // endlessly-retried row is also a row that never gets pruned.
    const { deps, setState } = harness({
      loadSpans: async () => {
        throw new Error("dexie closed")
      },
    })
    const result = await drainOnlineEvalQueue(20, deps)
    expect(result.failed).toBe(1)
    expect(setState).toHaveBeenLastCalledWith("q1", "failed", { error: "dexie closed" }, 1_000)
  })

  it("counts an attempt on every claim, so a repeatedly-failing row is visible", async () => {
    const { deps, setState } = harness({ claim: async () => [row({ attempts: 2 })] })
    await drainOnlineEvalQueue(20, deps)
    expect(setState.mock.calls[0]).toEqual(["q1", "running", { attempts: 3 }, 1_000])
  })

  describe("judge leg", () => {
    const judging = (overrides: Partial<OnlineEvalPolicyV1> = {}) =>
      policy({ judgeEvaluatorVersionIds: ["rubric@1"], ...overrides })

    it("takes no reservation at all when a policy has no judge", async () => {
      const { deps, reserve, settle } = harness()
      const result = await drainOnlineEvalQueue(20, deps)
      expect(reserve).not.toHaveBeenCalled()
      expect(settle).not.toHaveBeenCalled()
      expect(result.judgeDecisions).toEqual({ "skipped-no-judge": 1 })
    })

    it("charges the estimate against the cap before running, and releases it after", async () => {
      const { deps, reserve, settle } = harness({ policies: () => [judging()] })
      await drainOnlineEvalQueue(20, deps)
      expect(reserve).toHaveBeenCalledWith("p1", JUDGE_COST_ESTIMATE_USD, 5, 1_000)
      // Released with zero spend — the rubric call itself is not implemented
      // yet, and leaking the reservation would silently shrink the cap.
      expect(settle).toHaveBeenCalledWith("p1", JUDGE_COST_ESTIMATE_USD, 0, false, 1_000)
    })

    it("records a budget refusal as a decision instead of judging anyway", async () => {
      const { deps, reserve } = harness({
        policies: () => [judging()],
        budget: async () => ledger({ spentUsd: 5 }),
      })
      const result = await drainOnlineEvalQueue(20, deps)
      expect(result.judgeDecisions).toEqual({ "skipped-budget": 1 })
      expect(reserve).not.toHaveBeenCalled()
    })

    it("defers to the LEDGER when the pre-check passes but the reservation loses a race", async () => {
      // Two workers can both clear `decideJudgeSampling`; only one fits.
      const { deps } = harness({
        policies: () => [judging()],
        reserve: async () => false,
      })
      const result = await drainOnlineEvalQueue(20, deps)
      expect(result.judgeDecisions).toEqual({ "skipped-budget": 1 })
    })

    it("respects the daily ceiling independently of the budget", async () => {
      const { deps } = harness({
        policies: () => [judging({ sampling: { judgeRate: 1, judgeDailyMax: 2 } })],
        budget: async () => ledger({ judgedCount: 2 }),
      })
      const result = await drainOnlineEvalQueue(20, deps)
      expect(result.judgeDecisions).toEqual({ "skipped-daily-max": 1 })
    })

    it("does not sample a trace outside the rate", async () => {
      const { deps } = harness({
        policies: () => [judging({ sampling: { judgeRate: 0, judgeDailyMax: 200 } })],
      })
      const result = await drainOnlineEvalQueue(20, deps)
      expect(result.judgeDecisions).toEqual({ "skipped-not-sampled": 1 })
    })
  })
})
