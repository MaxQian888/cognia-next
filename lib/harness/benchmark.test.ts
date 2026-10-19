/** @jest-environment jsdom */
/**
 * The Harness Evolution benchmark (ADR-0237) on the real Dexie store
 * (fake-indexeddb). The deterministic scenarios must decide right on one seed;
 * the full multi-seed report runs with HARNESS_BENCHMARK=1 and is written to
 * HARNESS_BENCHMARK_REPORT when that is set.
 */

import { writeFileSync } from "node:fs"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  claimHarnessRunLease,
  createHarnessRun,
  deleteHarnessExperience,
  getHarnessExperience,
  getHarnessRun,
  getHarnessSnapshot,
  listHarnessExperiences,
  listHarnessSteps,
  listRolloutsByCacheKey,
  pruneHarnessHistory,
  putHarnessExperience,
  putHarnessSnapshot,
  putHarnessStep,
  saveHarnessRun,
  updateHarnessExperience,
} from "@/lib/db/harness-evolution"
import {
  BENCHMARK_MARKERS,
  DEFAULT_BENCHMARK_SCENARIOS,
  renderBenchmarkReport,
  runBenchmarkScenario,
  runHarnessBenchmark,
  simulateRollout,
  summarizeBenchmark,
  type BenchmarkRunResult,
  type HarnessBenchmarkStore,
} from "./benchmark"

const dbFixture = createDbTestFixture({ seeded: false })
beforeAll(dbFixture.initialize)
afterEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const store: HarnessBenchmarkStore = {
  createRun: createHarnessRun,
  getRun: getHarnessRun,
  saveRun: saveHarnessRun,
  claimLease: claimHarnessRunLease,
  listSteps: listHarnessSteps,
  putStep: putHarnessStep,
  getSnapshot: getHarnessSnapshot,
  putSnapshot: putHarnessSnapshot,
  listRolloutsByCacheKey,
  listExperiences: listHarnessExperiences,
  getExperience: getHarnessExperience,
  putExperience: putHarnessExperience,
  updateExperience: updateHarnessExperience,
  deleteExperience: deleteHarnessExperience,
  prune: pruneHarnessHistory,
}

const components = (memory: string) => ({
  systemPrompt: "x",
  guardrails: "",
  memory,
  toolGuidance: "",
  skills: [],
  subagents: [],
  toolRules: [],
})

describe("simulateRollout", () => {
  it("writes the report and the total only when the harness says so", () => {
    const both = simulateRollout(
      components(`${BENCHMARK_MARKERS.write}\n${BENCHMARK_MARKERS.total}`),
      false
    )
    expect(both.wroteReport).toBe(true)
    expect(both.finalText).toContain("total")
    const none = simulateRollout(components(""), false)
    expect(none.wroteReport).toBe(false)
    expect(none.finalText).not.toContain("total")
  })

  it("calls no tools when told not to, and fails when flaking", () => {
    const refusing = simulateRollout(
      components(`${BENCHMARK_MARKERS.write}\n${BENCHMARK_MARKERS.refuseTools}`),
      false
    )
    expect(refusing.entries.every((e) => e.kind === "assistant")).toBe(true)
    const flaked = simulateRollout(components(BENCHMARK_MARKERS.write), true)
    expect(flaked.wroteReport).toBe(false)
    expect(flaked.entries.some((e) => e.kind === "observation" && e.isError)).toBe(true)
  })

  it("makes verbose answers longer without changing what checks see", () => {
    const plain = simulateRollout(components(BENCHMARK_MARKERS.write), false)
    const verbose = simulateRollout(
      components(`${BENCHMARK_MARKERS.write}\n${BENCHMARK_MARKERS.verbose}`),
      false
    )
    expect(verbose.finalText.length).toBeGreaterThan(plain.finalText.length * 3)
    expect(verbose.wroteReport).toBe(plain.wroteReport)
  })
})

describe("runBenchmarkScenario", () => {
  const deterministic = DEFAULT_BENCHMARK_SCENARIOS.filter((s) => !s.flake)

  it.each(deterministic.map((s) => [s.id, s] as const))(
    "%s decides right",
    async (_id, scenario) => {
      const result = await runBenchmarkScenario(scenario, 1, store)
      expect(result).toMatchObject({ correct: true, withinBudget: true })
      expect(result.accountingHolds).not.toBe(false)
    }
  )

  it("chooses the checked final over the one a length-loving judge prefers", async () => {
    const scenario = DEFAULT_BENCHMARK_SCENARIOS.find((s) => s.id === "misleading-judge")
    const result = await runBenchmarkScenario(scenario!, 1, store)
    expect(result).toMatchObject({ outcome: "adopt", chosenLabel: "agg1", judgeCalls: 0 })
  })

  it("stops a run before it spends past its ceiling", async () => {
    const scenario = DEFAULT_BENCHMARK_SCENARIOS.find((s) => s.id === "budget-stop")
    const result = await runBenchmarkScenario(scenario!, 1, store)
    expect(result.status).toBe("budget_exceeded")
    expect(result.costUsd).toBeLessThanOrEqual(result.maxCostUsd)
    expect(result.accountingHolds).toBeNull()
  })

  it("reuses the base rollout for a proposal that kept the base", async () => {
    const scenario = DEFAULT_BENCHMARK_SCENARIOS.find((s) => s.id === "clear-improvement")
    const result = await runBenchmarkScenario(scenario!, 1, store)
    expect(result.reusedRollouts).toBeGreaterThanOrEqual(1)
    expect(result).toMatchObject({ rollouts: 4, editorSessions: 3 })
  })
})

describe("summarizeBenchmark and the report", () => {
  const row = (over: Partial<BenchmarkRunResult>): BenchmarkRunResult => ({
    scenario: "harmful-edit",
    seed: 1,
    status: "completed",
    outcome: "keep-base",
    correct: true,
    falseAdoption: false,
    missedImprovement: false,
    rollouts: 4,
    reusedRollouts: 1,
    editorSessions: 3,
    modelCalls: 4,
    judgeCalls: 0,
    costUsd: 0.1,
    maxCostUsd: 5,
    withinBudget: true,
    accountingHolds: true,
    wallMs: 5,
    ...over,
  })

  it("rates false adoptions against runs where the base was right", () => {
    const scenarios = DEFAULT_BENCHMARK_SCENARIOS.filter((s) =>
      ["harmful-edit", "clear-improvement"].includes(s.id)
    )
    const report = summarizeBenchmark(
      scenarios,
      [1, 2],
      [
        row({}),
        row({ seed: 2, outcome: "adopt", correct: false, falseAdoption: true }),
        row({ scenario: "clear-improvement", outcome: "adopt" }),
        row({
          scenario: "clear-improvement",
          seed: 2,
          correct: false,
          missedImprovement: true,
          withinBudget: false,
          accountingHolds: false,
        }),
      ]
    )
    expect(report.overall).toEqual({
      runs: 4,
      accuracy: 0.5,
      falseAdoptionRate: 0.5,
      missedImprovementRate: 0.5,
      budgetViolations: 1,
      accountingFailures: 1,
    })
    const markdown = renderBenchmarkReport(report)
    expect(markdown).toContain("| harmful-edit | 50% | 1 | 0 | 0 |")
    expect(markdown).toContain("False adoption rate (base was right): 50%")
  })
})

const benchmarkDescribe = process.env.HARNESS_BENCHMARK === "1" ? describe : describe.skip

benchmarkDescribe("full benchmark", () => {
  it("runs every scenario under five seeds", async () => {
    const report = await runHarnessBenchmark(store)
    const markdown = renderBenchmarkReport(report)
    console.log(markdown)
    if (process.env.HARNESS_BENCHMARK_REPORT) {
      writeFileSync(process.env.HARNESS_BENCHMARK_REPORT, `${markdown}\n`)
    }
    expect(report.overall.budgetViolations).toBe(0)
    expect(report.overall.accountingFailures).toBe(0)
  }, 120_000)
})
