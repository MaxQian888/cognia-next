/**
 * A lightweight, offline benchmark of the evolution loop (ADR-0237).
 *
 * Harness² measures its loop with real models on real tasks, which costs
 * money and cannot run in CI. This benchmark measures what the loop itself
 * decides, with the real driver, the real store, the real evidence checks and
 * the real selection, and only the model-facing steps simulated:
 *
 * - a rollout's outcome is a pure function of the harness it ran (marker
 *   lines in the always-on text: write the file, end with the total, refuse
 *   tools, be verbose), plus seeded flakiness;
 * - editors add the lines each scenario scripts per role and round;
 * - the selector is a scripted judge (one that prefers verbose answers, one
 *   that abstains, one with low confidence).
 *
 * Every scenario knows the right answer, so the report is decision quality
 * (adoptions of a real improvement, false adoptions, missed improvements),
 * budget discipline (spend against the ceiling) and accounting (R = 4k
 * rollouts and P = 3k editor sessions on a normal finish), per scenario and
 * seed. Nothing here calls a model or touches the user's data; the caller
 * provides the store (tests use the Dexie store on fake-indexeddb).
 */

import type { Character } from "@cognia/agent-config-types"
import { createSeededRandom } from "@cognia/eval-core/seeded-random"
import type {
  HarnessEvolutionBudget,
  HarnessEvolutionMode,
  HarnessEvolutionRun,
  HarnessEvolutionTask,
  HarnessRunStatus,
} from "@/types/harness/evolution"
import type { HarnessComponentsV1 } from "@/types/harness/snapshot"
import { DEFAULT_HARNESS_BUDGET, emptyLedger, normalizeBudget } from "./budget"
import { buildExecutionEvidence } from "./evidence"
import { runUsageSessionId, HARNESS_USAGE_SURFACE, type UsageRowLike } from "./ledger"
import type { EditorRole } from "./prompts"
import { parseReflection } from "./reflect"
import { driveHarnessRun, type HarnessDriverStore } from "./runtime/driver"
import { buildHarnessSnapshot } from "./snapshot"
import { summarizeTrajectory, type TrajectoryEntry } from "./trajectory"

/** Always-on lines the simulated executor reacts to. */
export const BENCHMARK_MARKERS = {
  /** The run writes report.md. */
  write: "Write the report to report.md before answering.",
  /** The answer ends with the total row. */
  total: "End the answer with the total row.",
  /** The run calls no tools at all: no file, and the checks fail. */
  refuseTools: "Never call tools; answer from memory.",
  /** The answer is long. Changes nothing a check can see. */
  verbose: "Explain every step at length.",
  /** A harmless style line. Changes nothing at all. */
  neutral: "Prefer short sentences.",
} as const

export type BenchmarkJudge = "verbose" | "abstain" | "low-confidence"

export interface HarnessBenchmarkScenario {
  id: string
  description: string
  mode: HarnessEvolutionMode
  k: number
  /** Marker lines the base harness already has. */
  baseLines: readonly string[]
  /**
   * Lines an editor adds, by role and 1-based index: the round in sequential
   * mode, the slot (`inv2`, `agg2`) in parallel mode.
   */
  edits(role: EditorRole, index: number): readonly string[]
  /** Chance a rollout flakes (a tool error, nothing delivered) whatever its harness. */
  flake?: number
  judge: BenchmarkJudge
  /** Labels whose first attempt times out (an outage, retried by the driver). */
  outages?: readonly string[]
  budget?: Partial<HarnessEvolutionBudget>
  /** Prices of one rollout and one model call. */
  prices?: { rollout: number; call: number }
  /** The right answer. `chosen` lists acceptable labels when a change is right. */
  expect: { outcome: "adopt" | "keep-base"; status?: HarnessRunStatus; chosen?: readonly string[] }
}

/** The scenarios the benchmark runs by default. */
export const DEFAULT_BENCHMARK_SCENARIOS: readonly HarnessBenchmarkScenario[] = [
  {
    id: "clear-improvement",
    description: "The base writes nothing; the invariant editor finds both missing rules.",
    mode: "parallel",
    k: 1,
    baseLines: [],
    edits: (role) => (role === "DOM" ? [] : [BENCHMARK_MARKERS.write, BENCHMARK_MARKERS.total]),
    judge: "abstain",
    expect: { outcome: "adopt", chosen: ["agg1", "inv1"] },
  },
  {
    id: "harmful-edit",
    description: "Every editor proposes a rule that stops tool use; the base was better.",
    mode: "parallel",
    k: 1,
    baseLines: [BENCHMARK_MARKERS.write],
    edits: () => [BENCHMARK_MARKERS.refuseTools],
    judge: "verbose",
    expect: { outcome: "keep-base" },
  },
  {
    id: "misleading-judge",
    description:
      "One final passes every check, the other is only longer; the judge prefers length.",
    mode: "parallel",
    k: 2,
    baseLines: [BENCHMARK_MARKERS.write],
    edits: (role, index) =>
      role === "INV" || (role === "COMPOSE" && index === 1)
        ? [BENCHMARK_MARKERS.total]
        : [BENCHMARK_MARKERS.verbose],
    judge: "verbose",
    expect: { outcome: "adopt", chosen: ["agg1"] },
  },
  {
    id: "tie-uncertain-judge",
    description: "Candidates change nothing a check sees and the judge is unsure.",
    mode: "parallel",
    k: 2,
    baseLines: [BENCHMARK_MARKERS.write, BENCHMARK_MARKERS.total],
    edits: () => [BENCHMARK_MARKERS.verbose],
    judge: "low-confidence",
    expect: { outcome: "keep-base" },
  },
  {
    id: "flaky-no-improvement",
    description:
      "A third of rollouts flake and the edits are neutral; any adoption is a false one.",
    mode: "parallel",
    k: 2,
    baseLines: [BENCHMARK_MARKERS.write, BENCHMARK_MARKERS.total],
    edits: () => [BENCHMARK_MARKERS.neutral],
    flake: 1 / 3,
    judge: "abstain",
    expect: { outcome: "keep-base" },
  },
  {
    id: "sequential-two-fixes",
    description: "Each round finds one of two rules; only the second round has both.",
    mode: "sequential",
    k: 2,
    baseLines: [],
    edits: (role, index) =>
      role === "DOM" ? [] : index === 1 ? [BENCHMARK_MARKERS.write] : [BENCHMARK_MARKERS.total],
    judge: "abstain",
    expect: { outcome: "adopt", chosen: ["c2"] },
  },
  {
    id: "budget-stop",
    description: "The budget affords the references and little else; the run must stop in time.",
    mode: "parallel",
    k: 2,
    baseLines: [],
    edits: () => [BENCHMARK_MARKERS.write, BENCHMARK_MARKERS.total],
    judge: "abstain",
    budget: { maxCostUsd: 0.25 },
    prices: { rollout: 0.1, call: 0.02 },
    expect: { outcome: "keep-base", status: "budget_exceeded" },
  },
  {
    id: "outage-retry",
    description: "A candidate's rollout times out once; the retry is the evidence.",
    mode: "parallel",
    k: 1,
    baseLines: [],
    edits: (role) => (role === "DOM" ? [] : [BENCHMARK_MARKERS.write, BENCHMARK_MARKERS.total]),
    outages: ["roll:inv1"],
    judge: "abstain",
    expect: { outcome: "adopt", chosen: ["agg1", "inv1"] },
  },
]

/** What the benchmark needs from the store: the driver's port plus run creation. */
export type HarnessBenchmarkStore = HarnessDriverStore & {
  createRun(run: HarnessEvolutionRun): Promise<unknown>
}

export interface BenchmarkRunResult {
  scenario: string
  seed: number
  status: HarnessRunStatus
  outcome: "adopt" | "keep-base" | "none"
  chosenLabel?: string
  correct: boolean
  /** Adopted although the right answer was to keep the base. */
  falseAdoption: boolean
  /** Kept the base although a real improvement was available. */
  missedImprovement: boolean
  rollouts: number
  reusedRollouts: number
  editorSessions: number
  modelCalls: number
  judgeCalls: number
  costUsd: number
  maxCostUsd: number
  withinBudget: boolean
  /** R = 4k and P = 3k held (only checked on a run that reached its decision normally). */
  accountingHolds: boolean | null
  wallMs: number
}

export interface BenchmarkScenarioSummary {
  scenario: string
  description: string
  runs: number
  accuracy: number
  falseAdoptions: number
  missedImprovements: number
  budgetViolations: number
  accountingFailures: number
  meanCostUsd: number
  meanRollouts: number
  meanReused: number
  meanEditorSessions: number
  meanJudgeCalls: number
}

export interface HarnessBenchmarkReport {
  seeds: readonly number[]
  results: BenchmarkRunResult[]
  scenarios: BenchmarkScenarioSummary[]
  overall: {
    runs: number
    accuracy: number
    falseAdoptionRate: number
    missedImprovementRate: number
    budgetViolations: number
    accountingFailures: number
  }
}

const TASK_PROMPT = "Summarise data.csv into report.md and give the total."

function benchmarkTask(scenario: string, seed: number): HarnessEvolutionTask {
  return {
    title: `Benchmark: ${scenario}`,
    prompt: TASK_PROMPT,
    domain: "benchmark/csv-report",
    isolation: "files",
    expectedDeliverables: ["report.md"],
    checks: [
      { kind: "deliverable-file", path: "report.md" },
      { kind: "output-contains", value: "total" },
    ],
    source: { kind: "custom" },
    // Per seed, so one seed's rollouts are never another seed's cache hits.
    inputHash: `bench-${scenario}-${seed}`,
  }
}

function baseComponents(lines: readonly string[]): HarnessComponentsV1 {
  return {
    systemPrompt: "You turn CSV files into short reports.",
    guardrails: "",
    memory: lines.join("\n"),
    toolGuidance: "",
    skills: [],
    subagents: [],
    toolRules: [],
  }
}

function alwaysOn(c: HarnessComponentsV1): string {
  return [c.systemPrompt, c.guardrails, c.memory, c.toolGuidance].join("\n")
}

/** What the simulated agent does under a harness. Exported for tests. */
export function simulateRollout(
  components: HarnessComponentsV1,
  flaked: boolean
): { entries: TrajectoryEntry[]; finalText: string; wroteReport: boolean } {
  const text = alwaysOn(components)
  const has = (line: string) => text.includes(line)
  const entries: TrajectoryEntry[] = []
  let wroteReport = false
  if (!has(BENCHMARK_MARKERS.refuseTools)) {
    entries.push({ kind: "action", toolName: "Read", input: { file_path: "data.csv" } })
    entries.push({
      kind: "observation",
      toolName: "Read",
      output: "region;amount\nnorth;10\nsouth;32",
      isError: false,
    })
    if (flaked) {
      entries.push({ kind: "action", toolName: "Bash", input: { command: "python sum.py" } })
      entries.push({
        kind: "observation",
        toolName: "Bash",
        output: "Traceback: KeyError 'amount'",
        isError: true,
      })
    } else if (has(BENCHMARK_MARKERS.write)) {
      entries.push({ kind: "action", toolName: "Write", input: { file_path: "report.md" } })
      entries.push({ kind: "observation", toolName: "Write", output: "ok", isError: false })
      wroteReport = true
    }
  }
  const parts = ["North 10, south 32."]
  if (has(BENCHMARK_MARKERS.verbose)) {
    parts.push(
      "First I read the file, then I parsed each row, then I added the amounts. ".repeat(6)
    )
  }
  if (has(BENCHMARK_MARKERS.total) && !flaked) parts.push("Grand total row: 42.")
  const finalText = parts.join(" ")
  entries.push({ kind: "assistant", text: finalText })
  return { entries, finalText, wroteReport }
}

function seedOf(...parts: readonly (string | number)[]): number {
  let h = 2166136261
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const BENCH_AGENT_RUNTIME = "hrf1-benchmark"

/** Run one scenario once with one seed. */
export async function runBenchmarkScenario(
  scenario: HarnessBenchmarkScenario,
  seed: number,
  store: HarnessBenchmarkStore
): Promise<BenchmarkRunResult> {
  const started = performance.now()
  const prices = scenario.prices ?? { rollout: 0.02, call: 0.005 }
  const budget = normalizeBudget({
    ...DEFAULT_HARNESS_BUDGET,
    maxIterations: Math.max(scenario.k, DEFAULT_HARNESS_BUDGET.maxIterations),
    maxCandidates: Math.max(2 * scenario.k, DEFAULT_HARNESS_BUDGET.maxCandidates),
    ...scenario.budget,
  })
  const runId = `bench-${scenario.id}-${seed}`
  const characterId = `bench-agent-${scenario.id}`
  const agent: Character = {
    id: characterId,
    name: `Benchmark ${scenario.id}`,
    avatarColor: "gray",
    systemPrompt: baseComponents([]).systemPrompt,
    createdAt: 0,
    updatedAt: 0,
  }
  const base = await buildHarnessSnapshot({
    id: `${runId}-base`,
    characterId,
    characterName: agent.name,
    scope: "task",
    components: baseComponents(scenario.baseLines),
    execution: {},
    runtimeFingerprint: BENCH_AGENT_RUNTIME,
    origin: { kind: "captured" },
    createdAt: 0,
  })
  await store.putSnapshot(base)
  const task = benchmarkTask(scenario.id, seed)
  await store.createRun({
    id: runId,
    characterId,
    characterName: agent.name,
    trigger: "manual",
    task,
    config: {
      mode: scenario.mode,
      k: scenario.k,
      scope: "task",
      editable: ["systemPrompt", "guardrails", "memory", "toolGuidance", "skills"],
      models: {},
      budget,
      autoAdoptLowRisk: false,
      useExperiences: true,
      editorChannel: "structured",
      probe: { allowedMcpServerIds: [], networkOff: true },
      seed,
    },
    status: "queued",
    round: 0,
    baseSnapshotId: base.id,
    finalLabels:
      scenario.mode === "parallel"
        ? Array.from({ length: scenario.k }, (_, i) => `agg${i + 1}`)
        : Array.from({ length: scenario.k }, (_, i) => `c${i + 1}`),
    experienceIds: [],
    ledger: emptyLedger(),
    dedupeKey: `hrd1-${runId}`,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  })

  const usage: UsageRowLike[] = []
  const book = (op: string, cost: number, tokens = 1_000) =>
    usage.push({
      messageId: `${HARNESS_USAGE_SURFACE}:${runUsageSessionId(runId)}:${op}`,
      inputTokens: tokens,
      outputTokens: Math.round(tokens / 10),
      costUsd: cost,
      costKnown: true,
    })
  const counts = { probes: 0, editors: 0, judge: 0 }
  const outages = new Set(scenario.outages ?? [])
  let clock = 1_000

  const run = await driveHarnessRun(runId, {
    ownerId: "benchmark",
    now: () => (clock += 1_000),
    newId: () => `${runId}-id-${++clock}`,
    leaseRenewMs: 60_000,
    store,
    capture: async () => ({
      snapshot: base,
      character: agent,
      skills: [],
      carriedSkillIds: [],
      enabledMcpServerIds: [],
      reused: true,
    }),
    listUsage: async () => usage,
    experienceCap: async () => 200,
    notifyAwaitingApproval: async () => undefined,
    runners: {
      discoverSurface: async () => ({ pluginToolDenials: [], allowedMcpServerNames: [] }),
      probe: async (input) => {
        counts.probes += 1
        book(`${input.label}:${input.attempt}`, prices.rollout)
        const outage = outages.has(input.label) && input.attempt === 1
        const random = createSeededRandom(seedOf(seed, scenario.id, input.label, input.attempt))
        const flaked = !outage && random() < (scenario.flake ?? 0)
        const sim = simulateRollout(input.snapshot.components, flaked)
        const evidence = buildExecutionEvidence({
          snapshotId: input.snapshot.id,
          task,
          environmentFingerprint: input.environmentFingerprint,
          trajectory: summarizeTrajectory(sim.entries),
          finalText: sim.finalText,
          deliverables: sim.wroteReport
            ? [{ path: "report.md", bytes: 32, text: "| region | amount |\n| total | 42 |" }]
            : [],
          filesObservable: true,
          usage: { inputTokens: 1_000, outputTokens: 100, totalCostUsd: prices.rollout },
          latencyMs: 4_000,
          blockedActions: [],
          degraded: false,
          ...(outage ? { error: "request timed out after 1200s" } : {}),
        })
        return {
          evidence,
          usage: {
            inputTokens: 1_000,
            outputTokens: 100,
            costUsd: prices.rollout,
            costUnknown: false,
          },
        }
      },
      editor: async (input) => {
        counts.editors += 1
        book(`${input.label}:${input.attempt}:1`, prices.call)
        const index = input.round ?? Number(/(\d+)$/.exec(input.label)?.[1] ?? 1)
        const add = scenario
          .edits(input.role, index)
          .filter((line) => !input.current.memory.split("\n").includes(line))
        const components = add.length
          ? {
              ...input.current,
              memory: [input.current.memory, ...add].filter(Boolean).join("\n"),
            }
          : input.current
        return {
          outcome: add.length ? "changed" : "kept",
          components,
          notes: add.length ? `Added: ${add.join(" / ")}` : "No change warranted.",
          attempts: 1,
          errors: [],
          channel: "structured",
          usage: {
            inputTokens: 1_000,
            outputTokens: 100,
            costUsd: prices.call,
            costUnknown: false,
          },
          modelCalls: 1,
        }
      },
      judge: (ctx) => async (entries) => {
        counts.judge += 1
        book(`select:${ctx.attempt}:${counts.judge}`, prices.call)
        if (scenario.judge === "abstain" || entries.length === 0) return null
        const ranked = [...entries].sort(
          (a, b) => b.evidence.output.length - a.evidence.output.length
        )
        return {
          best: ranked[0].id,
          ranking: ranked.map((e) => e.id),
          confidence: scenario.judge === "low-confidence" ? "low" : "high",
          evidence: Object.fromEntries(entries.map((e) => [e.id, "longer answer"])),
        }
      },
      reflect: async (ctx) => {
        book(`reflect:${ctx.attempt}:1`, prices.call)
        const parsed = parseReflection(
          JSON.stringify({
            edits: [
              {
                component: "memory.md",
                candidates: ctx.labels.filter((l) => l !== "base1"),
                change: "added marker lines",
                observed: "see the rollouts' checks",
                verdict:
                  ctx.reflection.decision.outcome === "adopt" ? "helped" : "no observed effect",
              },
            ],
            retrieved: [],
            experience: null,
          }),
          { labels: ctx.labels, retrievedIds: [] }
        )
        return {
          parsed,
          usage: {
            inputTokens: 1_000,
            outputTokens: 100,
            costUsd: prices.call,
            costUnknown: false,
          },
          model: "benchmark-reflector",
        }
      },
      adopt: async (input) => ({
        scope: input.run.config.scope,
        approvedBy: input.approvedBy,
        adoptedAt: clock,
      }),
    },
  })
  if (!run) throw new Error(`Benchmark run ${runId} vanished.`)

  const steps = await store.listSteps(runId)
  const rolloutSteps = steps.filter((s) => s.kind === "rollout")
  const reused = rolloutSteps.filter((s) => s.cacheHitOf).length
  const editorSteps = steps.filter((s) => s.kind === "propose" || s.kind === "compose").length
  const outcome = run.decision?.outcome ?? "none"
  const chosen = run.decision?.chosenLabel
  const statusOk = scenario.expect.status ? run.status === scenario.expect.status : true
  const chosenOk =
    scenario.expect.outcome !== "adopt" ||
    !scenario.expect.chosen ||
    (chosen !== undefined && scenario.expect.chosen.includes(chosen))
  const effectiveOutcome = outcome === "none" ? "keep-base" : outcome
  const correct = statusOk && effectiveOutcome === scenario.expect.outcome && chosenOk
  const decided = run.decision !== undefined && run.status !== "budget_exceeded"
  return {
    scenario: scenario.id,
    seed,
    status: run.status,
    outcome,
    ...(chosen ? { chosenLabel: chosen } : {}),
    correct,
    falseAdoption: scenario.expect.outcome === "keep-base" && outcome === "adopt",
    missedImprovement: scenario.expect.outcome === "adopt" && effectiveOutcome === "keep-base",
    rollouts: rolloutSteps.length,
    reusedRollouts: reused,
    editorSessions: editorSteps,
    modelCalls: run.ledger.modelCalls,
    judgeCalls: counts.judge,
    costUsd: run.ledger.costUsd,
    maxCostUsd: budget.maxCostUsd,
    withinBudget: run.ledger.costUsd <= budget.maxCostUsd + 1e-9,
    accountingHolds: decided
      ? rolloutSteps.length === 4 * scenario.k && editorSteps === 3 * scenario.k
      : null,
    wallMs: performance.now() - started,
  }
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

/** Aggregate per-run results. */
export function summarizeBenchmark(
  scenarios: readonly HarnessBenchmarkScenario[],
  seeds: readonly number[],
  results: readonly BenchmarkRunResult[]
): HarnessBenchmarkReport {
  const summaries = scenarios.map((scenario): BenchmarkScenarioSummary => {
    const rows = results.filter((r) => r.scenario === scenario.id)
    return {
      scenario: scenario.id,
      description: scenario.description,
      runs: rows.length,
      accuracy: rows.length ? rows.filter((r) => r.correct).length / rows.length : 0,
      falseAdoptions: rows.filter((r) => r.falseAdoption).length,
      missedImprovements: rows.filter((r) => r.missedImprovement).length,
      budgetViolations: rows.filter((r) => !r.withinBudget).length,
      accountingFailures: rows.filter((r) => r.accountingHolds === false).length,
      meanCostUsd: mean(rows.map((r) => r.costUsd)),
      meanRollouts: mean(rows.map((r) => r.rollouts)),
      meanReused: mean(rows.map((r) => r.reusedRollouts)),
      meanEditorSessions: mean(rows.map((r) => r.editorSessions)),
      meanJudgeCalls: mean(rows.map((r) => r.judgeCalls)),
    }
  })
  const keepBaseRuns = results.filter((r) =>
    scenarios.some((s) => s.id === r.scenario && s.expect.outcome === "keep-base")
  )
  const adoptRuns = results.filter((r) =>
    scenarios.some((s) => s.id === r.scenario && s.expect.outcome === "adopt")
  )
  return {
    seeds,
    results: [...results],
    scenarios: summaries,
    overall: {
      runs: results.length,
      accuracy: results.length ? results.filter((r) => r.correct).length / results.length : 0,
      falseAdoptionRate: keepBaseRuns.length
        ? keepBaseRuns.filter((r) => r.falseAdoption).length / keepBaseRuns.length
        : 0,
      missedImprovementRate: adoptRuns.length
        ? adoptRuns.filter((r) => r.missedImprovement).length / adoptRuns.length
        : 0,
      budgetViolations: results.filter((r) => !r.withinBudget).length,
      accountingFailures: results.filter((r) => r.accountingHolds === false).length,
    },
  }
}

/** Run every scenario under every seed, one run at a time. */
export async function runHarnessBenchmark(
  store: HarnessBenchmarkStore,
  options: { scenarios?: readonly HarnessBenchmarkScenario[]; seeds?: readonly number[] } = {}
): Promise<HarnessBenchmarkReport> {
  const scenarios = options.scenarios ?? DEFAULT_BENCHMARK_SCENARIOS
  const seeds = options.seeds ?? [1, 2, 3, 4, 5]
  const results: BenchmarkRunResult[] = []
  for (const scenario of scenarios) {
    for (const seed of seeds) results.push(await runBenchmarkScenario(scenario, seed, store))
  }
  return summarizeBenchmark(scenarios, seeds, results)
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`

/** The report as Markdown. */
export function renderBenchmarkReport(report: HarnessBenchmarkReport): string {
  const o = report.overall
  const lines = [
    `Seeds: ${report.seeds.join(", ")} · runs: ${o.runs}`,
    "",
    `- Decision accuracy: ${pct(o.accuracy)}`,
    `- False adoption rate (base was right): ${pct(o.falseAdoptionRate)}`,
    `- Missed improvement rate (a change was right): ${pct(o.missedImprovementRate)}`,
    `- Runs over budget: ${o.budgetViolations}`,
    `- Runs breaking R = 4k / P = 3k: ${o.accountingFailures}`,
    "",
    "| Scenario | Accuracy | False adopt | Missed | Over budget | Mean cost | Rollouts (reused) | Editor sessions | Judge calls |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.scenarios.map(
      (s) =>
        `| ${s.scenario} | ${pct(s.accuracy)} | ${s.falseAdoptions} | ${s.missedImprovements} | ${s.budgetViolations} | $${s.meanCostUsd.toFixed(3)} | ${s.meanRollouts.toFixed(1)} (${s.meanReused.toFixed(1)}) | ${s.meanEditorSessions.toFixed(1)} | ${s.meanJudgeCalls.toFixed(1)} |`
    ),
    "",
    ...report.scenarios.map((s) => `- **${s.scenario}**: ${s.description}`),
  ]
  return lines.join("\n")
}
