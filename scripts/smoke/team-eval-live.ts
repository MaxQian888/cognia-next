/** Opt-in live, synthetic, text-only comparison over the production eval host. */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import type { AppSettings } from "@cognia/agent-config-types"
import type { EvalSample } from "@/types/eval/eval"
import type { TeamEvalDefinition } from "@/lib/ai/eval/team-execution"
import { runIsolatedTeamEval } from "@/lib/ai/eval/team-execution"
import { createPureModelEvalTarget } from "@/lib/ai/eval/targets/model"
import { assembleSampleFromSpans } from "@/lib/ai/eval/targets/chat"
import {
  TEAM_BENCHMARK_CASES,
  benchmarkPrompt,
  benchmarkSchedule,
  checkBenchmarkOutput,
  benchmarkPercentile,
  validateBenchmarkEndpoint,
  type BenchmarkVariant,
} from "@/lib/ai/eval/benchmark-protocol"

const root = process.cwd()
const runDir = path.resolve(
  process.env.COGNIA_TEAM_EVAL_DIR ?? ".cache/team-squad-live-2026-10-25/run"
)
fs.mkdirSync(runDir, { recursive: true })
const key =
  process.env.COGNIA_TEAM_EVAL_API_KEY ??
  execFileSync(process.execPath, ["/Users/bytedance/Project/aiden-llm-proxy/dist/cli.js", "key"], {
    encoding: "utf8",
  }).trim()
const baseURL = validateBenchmarkEndpoint(
  process.env.COGNIA_TEAM_EVAL_BASE_URL ?? "http://127.0.0.1:8787/v1"
)
const model = process.env.COGNIA_TEAM_EVAL_MODEL ?? "ark-deepseek-v4.1-flash"
const count = Number(process.env.COGNIA_TEAM_EVAL_CASES ?? TEAM_BENCHMARK_CASES.length)
const repetitions = Number(process.env.COGNIA_TEAM_EVAL_REPETITIONS ?? 3)
if (!Number.isInteger(count) || count < 1 || count > TEAM_BENCHMARK_CASES.length)
  throw new Error("Invalid benchmark case count")
const cases = TEAM_BENCHMARK_CASES.slice(0, count)
const schedule = benchmarkSchedule(
  cases.map((item) => item.id),
  repetitions,
  20261025
)
const settings = {
  defaultProvider: "openai",
  defaultModel: model,
  providerSettings: {
    openai: { enabled: true, apiKey: key, baseURL, defaultModel: model, apiFlavor: "chat" },
  },
} as unknown as AppSettings
const datasetDigest = createHash("sha256").update(JSON.stringify(cases)).digest("hex")
const manifest = {
  schema: "cognia-team-benchmark/v1",
  startedAt: new Date().toISOString(),
  model,
  baseURL,
  profile: "isolated-text",
  datasetDigest,
  repetitions,
  seed: 20261025,
  outerConcurrency: 1,
  maxOutputTokensPerCall: 2048,
  maxRunTokens: 32768,
  monetaryPrice: null,
  monetaryCostAvailable: false,
  node: process.version,
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: root }).trim(),
  sourceManifest: process.env.COGNIA_TEAM_EVAL_SOURCE_MANIFEST
    ? JSON.parse(fs.readFileSync(process.env.COGNIA_TEAM_EVAL_SOURCE_MANIFEST, "utf8"))
    : null,
  singleAgentProfile: "single-call isolated-text Agent",
  schedule,
  cases,
}
fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
  flag: "wx",
})
type RecordRow = {
  caseId: string
  repetition: number
  variant: BenchmarkVariant
  startedAt: string
  elapsedMs: number
  status: string
  success: boolean
  output: string
  reason?: string
  sample?: EvalSample
}
const records: RecordRow[] = []
const target = createPureModelEvalTarget({
  label: "single-agent",
  providerId: "openai",
  modelId: model,
  isLocal: false,
  settings: {
    defaultProvider: "openai",
    providerSettings: settings.providerSettings ?? {},
    customProviders: settings.customProviders,
  },
  parameters: { maxOutputTokens: 2048, temperature: 0 },
})

function persist() {
  const variants: BenchmarkVariant[] = ["single-agent", "serial-squad", "parallel-squad"]
  const summary = variants.map((variant) => {
    const rows = records.filter((row) => row.variant === variant)
    const successes = rows.filter((row) => row.success).length
    const timings = rows.map((row) => row.elapsedMs)
    const usageRows = rows.filter(
      (row) => row.sample && row.sample.metricAvailability?.usage !== "unavailable"
    )
    const completeUsage = rows.filter(
      (row) => row.sample?.metricAvailability?.usage === "known"
    ).length
    const sum = (field: keyof EvalSample["usage"]) =>
      usageRows.reduce((total, row) => total + (row.sample?.usage[field] ?? 0), 0)
    return {
      variant,
      attempts: rows.length,
      successes,
      successRate: rows.length ? successes / rows.length : null,
      p50Ms: benchmarkPercentile(timings, 0.5),
      p95Ms: benchmarkPercentile(timings, 0.95),
      totalWallMs: timings.reduce((a, b) => a + b, 0),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      measuredUsageAttempts: completeUsage,
      partialUsageAttempts: usageRows.length - completeUsage,
      unmeasuredUsageAttempts: rows.length - usageRows.length,
      tokenTotalsAreLowerBounds: completeUsage !== rows.length,
      tokensPerSolved: successes ? (sum("inputTokens") + sum("outputTokens")) / successes : null,
      currencyCost: null,
      costAvailability: "unavailable",
      errors: rows
        .filter((row) => row.status !== "completed")
        .map((row) => ({
          caseId: row.caseId,
          repetition: row.repetition,
          reason: row.reason,
          status: row.status,
        })),
    }
  })
  fs.writeFileSync(
    path.join(runDir, "results.json"),
    JSON.stringify(
      {
        manifest,
        finishedAttempts: records.length,
        plannedAttempts: schedule.length,
        complete: records.length === schedule.length,
        summary,
        records,
      },
      null,
      2
    ) + "\n"
  )
  return summary
}

for (const entry of schedule) {
  const item = cases.find((candidate) => candidate.id === entry.caseId)!
  const startedAt = new Date().toISOString()
  const began = performance.now()
  fs.appendFileSync(
    path.join(runDir, "attempts.ndjson"),
    JSON.stringify({ ...entry, startedAt, status: "started" }) + "\n"
  )
  let sample: EvalSample | undefined
  let status = "failed"
  let reason: string | undefined
  let output = ""
  try {
    if (entry.variant === "single-agent") {
      sample = await target.run(
        {
          id: item.id,
          datasetId: datasetDigest,
          input: benchmarkPrompt(item),
          capability: "text",
          source: "handwritten",
          createdAt: 0,
          updatedAt: 0,
        },
        AbortSignal.timeout(120_000)
      )
      status = sample.executionStatus ?? "completed"
      output = sample.output
    } else {
      const definition: TeamEvalDefinition = {
        team: {
          id: "benchmark-source",
          name: "Frozen reasoning Squad",
          leadId: "lead",
          task: benchmarkPrompt(item),
          config: {
            ...DEFAULT_TEAM_CONFIG,
            defaultProvider: "openai",
            defaultModel: model,
            defaultTemperature: 0,
            defaultTimeout: 120_000,
            tokenBudget: 32768,
            maxConcurrentTeammates: entry.variant === "serial-squad" ? 1 : 2,
            riskGating: false,
          },
        } as TeamEvalDefinition["team"],
        members: ["one", "two"].map((id) => ({
          id,
          teamId: "benchmark-source",
          name: id,
          description: "Precise structured reasoning solver",
          role: "teammate",
          config: { provider: "openai", model },
        })) as TeamEvalDefinition["members"],
        tasks: [
          {
            id: "x",
            title: "Solve x",
            description: "Solve Part x of the objective. Return only a JSON object with key x.",
            dependencies: [],
          },
          {
            id: "y",
            title: "Solve y",
            description: "Solve Part y of the objective. Return only a JSON object with key y.",
            dependencies: [],
          },
          {
            id: "final",
            title: "Assemble final answer",
            description:
              "Combine dependency answers into the final JSON object with exactly keys x and y. Return only JSON.",
            dependencies: ["x", "y"],
          },
        ].map((task) => ({
          ...task,
          teamId: "benchmark-source",
          status: "pending",
          priority: "normal",
          tags: [],
          createdAt: new Date(0),
          order: 0,
        })) as TeamEvalDefinition["tasks"],
        settings,
      }
      const captured: unknown[] = []
      const run = await runIsolatedTeamEval(
        {
          teamId: "benchmark-source",
          prompt: benchmarkPrompt(item),
          traceId: `benchmark-${item.id}-${entry.repetition}-${entry.variant}`,
          timeoutMs: 120_000,
          onSpan: (span) => {
            captured.push(span)
            fs.appendFileSync(
              path.join(runDir, "calls.ndjson"),
              JSON.stringify({ ...entry, span }) + "\n"
            )
          },
        },
        { loadDefinition: async () => definition }
      )
      status = run.status
      reason = run.reason
      output = typeof run.output === "string" ? run.output : ""
      sample = assembleSampleFromSpans(run.spans, { output, degraded: false })
      sample.latencyMs = run.wallTimeMs
      sample.executionStatus = run.status
      sample.executionProfile = "isolated-text"
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  const row: RecordRow = {
    ...entry,
    startedAt,
    elapsedMs: performance.now() - began,
    status,
    success: status === "completed" && checkBenchmarkOutput(item, output),
    output,
    ...(reason ? { reason } : {}),
    ...(sample ? { sample } : {}),
  }
  records.push(row)
  fs.appendFileSync(path.join(runDir, "attempts.ndjson"), JSON.stringify(row) + "\n")
  persist()
  console.log(
    JSON.stringify({
      finished: records.length,
      planned: schedule.length,
      ...entry,
      status,
      success: row.success,
      elapsedMs: Math.round(row.elapsedMs),
      inputTokens: sample?.usage.inputTokens,
      outputTokens: sample?.usage.outputTokens,
      reason,
    })
  )
}
console.log(JSON.stringify({ complete: true, runDir, summary: persist() }))
