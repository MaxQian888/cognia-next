import type { HarnessEvolutionStep } from "@/types/harness/evolution"
import { emptyLedger } from "./budget"
import {
  budgetMeters,
  comparableLabels,
  rolloutOf,
  runActions,
  runTimeline,
  spendByKind,
  statusTone,
  stepLabelParts,
} from "./run-view"
import { makeRun, makeRunConfig } from "./test-fixtures"

const step = (label: string, over: Partial<HarnessEvolutionStep> = {}): HarnessEvolutionStep => ({
  id: `run-1:${label}`,
  runId: "run-1",
  label,
  kind: "rollout",
  status: "succeeded",
  attempts: 1,
  inputTokens: 10,
  outputTokens: 5,
  modelCalls: 0,
  updatedAt: 1,
  ...over,
})

describe("runActions", () => {
  it("offers what each state allows", () => {
    expect(runActions(makeRun({ status: "awaiting_approval" }), 0, false)).toEqual({
      cancel: true,
      resume: false,
      approve: true,
      reject: true,
      rollback: false,
    })
    expect(runActions(makeRun({ status: "interrupted" }), 0, false).resume).toBe(true)
    // A working run with a live lease, or driven here, is not resumable.
    const live = makeRun({ status: "probing", owner: { ownerId: "x", leaseExpiresAt: 100 } })
    expect(runActions(live, 50, false).resume).toBe(false)
    expect(runActions(live, 150, false).resume).toBe(true)
    expect(runActions(live, 150, true).resume).toBe(false)
    const adopted = makeRun({
      status: "completed",
      adoption: { scope: "global", approvedBy: "person", adoptedAt: 1 },
    })
    expect(runActions(adopted, 0, false)).toMatchObject({ rollback: true, cancel: false })
    expect(
      runActions({ ...adopted, adoption: { ...adopted.adoption!, rolledBackAt: 2 } }, 0, false)
        .rollback
    ).toBe(false)
  })
})

describe("runTimeline", () => {
  it("groups the plan by phase and attaches the steps that exist", () => {
    const groups = runTimeline(makeRun({ config: makeRunConfig({ mode: "parallel", k: 1 }) }), [
      step("base1"),
      step("inv1", { kind: "propose" }),
    ])
    expect(groups.map((g) => [g.phase, g.steps.map((s) => s.planned.label)])).toEqual([
      ["reference_running", ["base1"]],
      ["proposing", ["inv1", "dom1"]],
      ["probing", ["roll:inv1", "roll:dom1"]],
      ["composing", ["agg1"]],
      ["probing", ["roll:agg1"]],
      ["evaluating", ["select"]],
      ["reflecting", ["reflect"]],
    ])
    expect(groups[1].steps[0].step?.label).toBe("inv1")
    expect(groups[1].steps[1].step).toBeUndefined()
  })

  it("keeps sequential rounds apart", () => {
    const groups = runTimeline(makeRun({ config: makeRunConfig({ mode: "sequential", k: 2 }) }), [])
    expect(groups.filter((g) => g.phase === "proposing").map((g) => g.round)).toEqual([1, 2])
  })
})

describe("stepLabelParts", () => {
  it("reads every label shape", () => {
    expect(stepLabelParts("base2")).toEqual({ kind: "base", index: 2 })
    expect(stepLabelParts("inv1")).toEqual({ kind: "invariant", index: 1 })
    expect(stepLabelParts("dom3")).toEqual({ kind: "domain", index: 3 })
    expect(stepLabelParts("agg1")).toEqual({ kind: "aggregate", index: 1 })
    expect(stepLabelParts("c2")).toEqual({ kind: "compose", index: 2 })
    expect(stepLabelParts("roll:agg1")).toEqual({ kind: "rollout", of: "agg1" })
    expect(stepLabelParts("select")).toEqual({ kind: "select" })
    expect(stepLabelParts("reflect")).toEqual({ kind: "reflect" })
  })
})

describe("budgetMeters", () => {
  it("reports each ceiling's share, flagging an unpriced cost as a lower bound", () => {
    const ledger = {
      ...emptyLedger(),
      costUsd: 2.5,
      costUnknown: true,
      inputTokens: 900,
      outputTokens: 100,
      modelCalls: 50,
    }
    const budget = makeRunConfig().budget
    const meters = budgetMeters(ledger, budget, { startedAt: 0, now: budget.maxWallTimeMs / 2 })
    expect(meters).toEqual([
      { dimension: "cost", used: 2.5, limit: 5, fraction: 0.5, lowerBound: true },
      {
        dimension: "tokens",
        used: 1000,
        limit: budget.maxTokens,
        fraction: 1000 / budget.maxTokens,
      },
      { dimension: "modelCalls", used: 50, limit: 40, fraction: 1 },
      {
        dimension: "wallTime",
        used: budget.maxWallTimeMs / 2,
        limit: budget.maxWallTimeMs,
        fraction: 0.5,
      },
    ])
    expect(budgetMeters(ledger, budget, { now: 5 })[3].used).toBe(0)
  })
})

describe("comparison helpers", () => {
  const steps = [
    step("base1"),
    step("inv1", { kind: "propose", snapshotId: "s-inv" }),
    step("dom1", { kind: "propose", status: "failed" }),
    step("roll:inv1", { cacheHitOf: "run-1:base1" }),
    step("agg1", { kind: "compose", snapshotId: "s-agg" }),
  ]

  it("lists the harnesses a person can compare and finds their rollouts", () => {
    expect(comparableLabels(steps)).toEqual(["base", "inv1", "agg1"])
    expect(rolloutOf("base", steps)?.label).toBe("base1")
    expect(rolloutOf("inv1", steps)?.label).toBe("roll:inv1")
    expect(rolloutOf("agg1", steps)).toBeUndefined()
  })

  it("sums spend per kind and counts reused rollouts", () => {
    const spend = spendByKind([
      ...steps,
      step("select", { kind: "select", costUsd: 0.01 }),
      step("base2", { costUsd: 0.2 }),
    ])
    expect(spend.rollout).toEqual({ costUsd: 0.2, tokens: 45, count: 3, cached: 1 })
    expect(spend.select?.costUsd).toBe(0.01)
  })

  it("gives every status a tone", () => {
    expect(statusTone("awaiting_approval")).toBe("attention")
    expect(statusTone("completed")).toBe("good")
    expect(statusTone("budget_exceeded")).toBe("bad")
    expect(statusTone("probing")).toBe("working")
  })
})
