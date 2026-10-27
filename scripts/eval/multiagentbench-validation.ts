/** Node-only validation of frozen options and recovered projection inputs. */
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { validateBenchmarkEndpoint } from "@/lib/ai/eval/benchmark-protocol"
import {
  MULTIAGENTBENCH_PROFILE,
  MULTIAGENTBENCH_EVALUATION_PROTOCOL,
  parseResearchAssessment,
  parseCommunicationRating,
  parseResearchMilestones,
  researchStructure,
} from "@/lib/ai/eval/multiagentbench"
import type { BenchmarkOptions } from "./multiagentbench-runner"
import type { ResearchCallEvent, ResearchTrial } from "@/lib/ai/eval/multiagentbench-runtime"
import type { EvalSample } from "@/types/eval/eval"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid benchmark object")
  return value as Record<string, unknown>
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw Error("Invalid benchmark identifier")
}
function finite(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw Error("Invalid benchmark metric")
}
function integer(value: unknown, min: number, max: number): number {
  finite(value)
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Error("Invalid benchmark integer option")
  return value
}
function member(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value)
}
function same(actual: unknown, expected: unknown, label: string) {
  if (!isDeepStrictEqual(actual, expected)) throw Error(`Inconsistent benchmark ${label}`)
}

export function validateBenchmarkOptions(value: unknown): BenchmarkOptions {
  const row = object(value)
  const result = { ...row } as unknown as BenchmarkOptions
  const bounds = {
    cases: [1, 100],
    repetitions: [1, 10],
    seed: [0, 0xffff_ffff],
    timeoutMs: [1000, 3_600_000],
    judgeTimeoutMs: [1000, 3_600_000],
    tokenBudget: [1, 2_000_000],
    judgeTokenBudget: [1, 2_000_000],
    maxSolverOutputTokens: [1, 32768],
    maxJudgeOutputTokens: [1, 16384],
    diagnosticEvery: [1, 100],
  } as const
  for (const [key, [min, max]] of Object.entries(bounds)) integer(row[key], min, max)
  for (const key of ["dryRun", "offline"])
    if (typeof row[key] !== "boolean") throw Error(`Invalid benchmark ${key}`)
  for (const key of ["model", "judgeModel"])
    if (typeof row[key] !== "string" || !/^[a-zA-Z0-9_./:-]{1,200}$/.test(row[key]))
      throw Error("Invalid benchmark model ID")
  if (
    !member(row.reasoningEffort, ["low", "medium", "high"]) ||
    !member(row.diagnostics, ["all", "primary", "sampled"])
  )
    throw Error("Invalid benchmark protocol option")
  text(row.runDir)
  if (!path.isAbsolute(row.runDir)) throw Error("Benchmark run directory must be absolute")
  if (row.sourceDir !== undefined) text(row.sourceDir)
  if (
    row.taskIds !== undefined &&
    (!Array.isArray(row.taskIds) ||
      !row.taskIds.length ||
      row.taskIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(id)) ||
      new Set(row.taskIds).size !== row.taskIds.length)
  )
    throw Error("Invalid benchmark task IDs")
  text(row.baseURL)
  result.baseURL = validateBenchmarkEndpoint(row.baseURL)
  // The launcher also returns control flags; none belongs to a frozen execution protocol.
  for (const key of ["help", "retryInterrupted", "resumeDir"])
    if (row[key] !== undefined && row[key] !== false)
      throw Error("Unexpected launcher control flag")
  const allowed = new Set([
    ...Object.keys(bounds),
    "dryRun",
    "offline",
    "taskIds",
    "model",
    "judgeModel",
    "reasoningEffort",
    "baseURL",
    "sourceDir",
    "runDir",
    "diagnostics",
    "help",
    "retryInterrupted",
    "resumeDir",
  ])
  if (Object.keys(row).some((key) => !allowed.has(key))) throw Error("Unknown benchmark option")
  delete (result as unknown as Record<string, unknown>).help
  delete (result as unknown as Record<string, unknown>).retryInterrupted
  delete (result as unknown as Record<string, unknown>).resumeDir
  return result
}

export function validateFrozenManifest(
  manifest: Record<string, unknown>,
  planned: Record<string, unknown>
) {
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)))
    throw Error("Invalid frozen manifest date")
  if (manifest.mode !== "live") throw Error("Only a live benchmark can be resumed")
  same(
    { ...manifest, createdAt: undefined },
    { ...planned, createdAt: undefined },
    "frozen manifest"
  )
}

export function validateBenchmarkSample(value: unknown): asserts value is EvalSample {
  const row = object(value)
  if (
    typeof row.output !== "string" ||
    !Array.isArray(row.toolCalls) ||
    !Array.isArray(row.retrievedChunks) ||
    typeof row.degraded !== "boolean"
  )
    throw Error("Invalid benchmark sample")
  const usage = object(row.usage)
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"])
    finite(usage[key])
  finite(row.costUsd)
  finite(row.latencyMs)
  integer(row.stepCount, 0, Number.MAX_SAFE_INTEGER)
  if (row.metricAvailability !== undefined) {
    const availability = object(row.metricAvailability)
    if (!member(availability.usage, ["known", "partial", "unavailable"]))
      throw Error("Invalid benchmark usage availability")
  }
  if (row.error !== undefined && typeof row.error !== "string") throw Error("Invalid sample error")
  if (
    row.executionStatus !== undefined &&
    !member(row.executionStatus, ["completed", "failed", "cancelled", "timed_out", "blocked"])
  )
    throw Error("Invalid sample execution status")
}

export function validateBenchmarkCall(value: unknown): asserts value is ResearchCallEvent {
  const row = object(value)
  text(row.callId)
  if (!member(row.state, ["admitted", "settled"])) throw Error("Invalid call state")
  if (row.phase === "solver") {
    text(row.agentId)
    text(row.taskId)
    if (row.judgmentKind !== undefined) throw Error("Solver call has a judge identity")
  } else if (row.phase === "judge") {
    if (
      !member(row.judgmentKind, ["research", "communication", "milestones"]) ||
      row.agentId !== undefined ||
      row.taskId !== undefined
    )
      throw Error("Invalid judge identity")
  } else throw Error("Invalid call phase")
  if (row.error !== undefined && typeof row.error !== "string") throw Error("Invalid call error")
  if (row.state === "admitted" && (row.sample !== undefined || row.error !== undefined))
    throw Error("Admission cannot carry a response")
  if (row.sample !== undefined) validateBenchmarkSample(row.sample)
  if (row.dependencies !== undefined) {
    if (!Array.isArray(row.dependencies)) throw Error("Invalid call dependencies")
    for (const value of row.dependencies) {
      const dependency = object(value)
      text(dependency.agentId)
      text(dependency.taskId)
      if (typeof dependency.output !== "string") throw Error("Invalid dependency output")
    }
  }
}

export function validateBenchmarkTrial(value: unknown): asserts value is ResearchTrial {
  const row = object(value)
  text(row.taskId)
  if (
    row.profile !== MULTIAGENTBENCH_PROFILE ||
    row.evaluationProtocol !== MULTIAGENTBENCH_EVALUATION_PROTOCOL ||
    !member(row.variant, ["single-agent", "serial-squad", "parallel-squad"])
  )
    throw Error("Invalid trial protocol")
  integer(row.repetition, 1, 10)
  const solver = object(row.solver)
  if (
    !member(solver.status, ["completed", "failed", "cancelled", "timed_out", "blocked"]) ||
    typeof solver.output !== "string" ||
    !Array.isArray(solver.contributions)
  )
    throw Error("Invalid solver settlement")
  finite(solver.wallTimeMs)
  if (solver.sample !== undefined) validateBenchmarkSample(solver.sample)
  if (solver.status === "completed" && (!solver.output.trim() || !solver.sample))
    throw Error("Completed solver requires an output and sample")
  const agents = new Set<string>()
  for (const value of solver.contributions) {
    const contribution = object(value)
    text(contribution.agentId)
    text(contribution.taskId)
    if (typeof contribution.output !== "string") throw Error("Invalid contribution output")
    agents.add(contribution.agentId)
  }
  same(row.acceptance, researchStructure(solver.output), "structure projection")
  const contracts = solver.contributions
    .filter((value) => object(value).taskId !== "final-proposal")
    .map((value) => {
      const contribution = object(value)
      const output = contribution.output as string
      const words = output.trim() ? output.trim().split(/\s+/).length : 0
      return {
        agentId: contribution.agentId,
        taskId: contribution.taskId,
        words,
        withinLimit: words <= 300,
      }
    })
  same(row.contributionContract, contracts, "contribution projection")
  if (!Array.isArray(row.judgments) || row.judgments.length !== 3)
    throw Error("Invalid trial judgments")
  const kinds = new Set<string>()
  for (const value of row.judgments) {
    const judgment = object(value)
    const kind = judgment.kind
    if (
      !member(kind, ["research", "communication", "milestones"]) ||
      kinds.has(kind) ||
      !member(judgment.status, ["graded", "error", "skipped", "not_applicable"]) ||
      typeof judgment.attempted !== "boolean"
    )
      throw Error("Invalid judgment settlement")
    kinds.add(kind)
    if (judgment.sample !== undefined) validateBenchmarkSample(judgment.sample)
    if (!judgment.attempted && judgment.sample !== undefined)
      throw Error("Unattempted judge has a sample")
    if (judgment.status === "graded") {
      if (!judgment.attempted || !judgment.sample || solver.status !== "completed")
        throw Error("Graded judgment requires a completed sample")
      const sample = judgment.sample as EvalSample
      if (sample.error || (sample.executionStatus && sample.executionStatus !== "completed"))
        throw Error("Failed sample cannot be graded")
      if (kind === "research") {
        text(judgment.visibleProposal)
        const parsed = parseResearchAssessment(sample.output, judgment.visibleProposal)
        same(judgment.ratings, parsed.ratings, "ratings")
        same(judgment.evidence, parsed.evidence, "research evidence")
      } else if (kind === "communication")
        same(
          judgment.communicationRating,
          parseCommunicationRating(sample.output),
          "communication rating"
        )
      else
        same(judgment.milestones, parseResearchMilestones(sample.output, [...agents]), "milestones")
    } else if (
      judgment.ratings !== undefined ||
      judgment.evidence !== undefined ||
      judgment.communicationRating !== undefined ||
      judgment.milestones !== undefined
    )
      throw Error("Ungraded judgment cannot project a score")
  }
}
