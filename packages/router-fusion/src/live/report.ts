/**
 * The live smoke's report (ADR-0188 D20, Verification §6; EVAL-04).
 *
 * One JSON document and its Markdown rendering. Every figure in it comes from
 * the run's own ledger — the attempt rows, the settled amounts, the run's
 * budget — joined with what the executor window observed on the way
 * (`observed-executor.ts`). Nothing is estimated after the fact.
 *
 * The label is part of the document, not the file name: a report of a run
 * against the Fake Provider is `simulated`, carries a disclaimer that it
 * claims no real quality, latency, cost or saving, and cannot be rendered
 * without it (EVAL-04). Only a run against real providers is `live`.
 */

import type { ExecutionMode } from "../contracts/schemas"
import { addMicrousd, type Microusd } from "../money/microusd"
import { formatUsd } from "./cap"
import type { LiveSmokeCaseId } from "./cases"
import type { ObservedCall } from "./observed-executor"
import { providerOfDeployment, type LiveProviderListing } from "./providers"

export const LIVE_SMOKE_REPORT_SCHEMA = "cognia-router-fusion-live-smoke" as const
export const LIVE_SMOKE_REPORT_VERSION = 1 as const

export type LiveSmokeLabel = "live" | "simulated"

export type LiveCaseOutcome =
  "succeeded" | "failed" | "cancelled" | "skipped" | "refused" | "error" | "not_run"

/** The ledger's usage buckets for one call (`NormalizedUsage`), under report names. */
export interface UsageBuckets {
  inputUncached: number
  inputCacheRead: number
  inputCacheWrite5m: number
  inputCacheWrite1h: number
  output: number
  reasoning: number
}

/** The slice of a ledger attempt row the report reads. */
export interface AttemptLike {
  attemptId: string
  logicalStepId: string
  attemptNo: number
  role: string
  deploymentId: string
  state: string
  providerRequestId: string | null
  actualMicrousd: number | null
  costStatus: string | null
  errorClass: string | null
  usage: Record<string, unknown> | null
}

export interface LiveCallRecord {
  attemptId: string
  logicalStepId: string
  attemptNo: number
  role: string
  deploymentId: string
  /** The attempt's ledger state (SUCCEEDED, FAILED, UNKNOWN, …). */
  state: string
  providerRequestId: string | null
  actualMicrousd: number | null
  costStatus: string | null
  errorClass: string | null
  usage: UsageBuckets | null
  /** Whether reasoning tokens were already inside `output` (null: not reported). */
  reasoningIncludedInOutput: boolean | null
  /** From the executor window; null for an attempt that was never handed to the executor. */
  latencyMs: number | null
  retryAfterMs: number | null
  finishReason: string | null
}

export interface RetrySummary {
  logicalSteps: number
  ledgerAttempts: number
  /** Steps that took more than one transport attempt, and what the failed ones failed with. */
  retriedSteps: Array<{ logicalStepId: string; attempts: number; errorClasses: string[] }>
  /** Calls the executor actually made. */
  executorCalls: number
  /** Executor calls with no ledger attempt behind them: must be 0. */
  unledgeredCalls: number
  /** HTTP requests seen on the wire during the case; null when the wire was not observed. */
  httpRequests: number | null
  /**
   * Requests beyond one per executor call — a retry hidden inside an SDK would
   * appear here (the executor runs with `maxRetries: 0`); null when not observed.
   */
  extraHttpRequests: number | null
  retryAfterMs: number[]
}

export interface LiveCaseRoute {
  actionId: string
  ruleId: string | null
  roles: Record<string, string>
  /** The router's worst-case reservation for the chosen action. */
  reserveMicrousd: number | null
  reasonCodes: string[]
}

export interface LiveCaseResult {
  qualityStatus: string
  verificationStatus: string
  warnings: string[]
  answerChars: number
  answerPreview: string
}

export interface LiveCaseReport {
  id: LiveSmokeCaseId
  mode: ExecutionMode
  title: string
  outcome: LiveCaseOutcome
  detail: string
  runId: string | null
  capMicrousd: number
  spentMicrousd: number
  overspendMicrousd: number
  modelCalls: number
  costStatus: string | null
  route: LiveCaseRoute | null
  /** The router's or the ledger's reasons for a skip or a refusal. */
  reasons: string[]
  result: LiveCaseResult | null
  error: { code: string; message: string } | null
  calls: LiveCallRecord[]
  usage: UsageBuckets
  retry: RetrySummary
  /** Journal event types and how often each was written. */
  events: Record<string, number>
  /** Cross-database effects the run queued, by kind (recorded, not applied to any account). */
  effects: Record<string, number>
  durationMs: number
}

export interface CapabilityRow {
  deploymentId: string
  providerId: string
  calls: number
  succeeded: number
  requestIds: "all" | "some" | "none"
  /** Usage buckets the provider reported non-zero at least once. */
  usageBuckets: string[]
  reasoningIncludedInOutput: boolean | null
  retryAfterSeen: boolean
  errorClasses: string[]
}

export interface LiveSmokeReport {
  schema: typeof LIVE_SMOKE_REPORT_SCHEMA
  version: typeof LIVE_SMOKE_REPORT_VERSION
  label: LiveSmokeLabel
  generatedAt: string
  disclaimer: string
  budgetMode: "strict" | "tracked"
  totalCapMicrousd: number
  plannedMicrousd: number
  totalSpentMicrousd: number
  remainingMicrousd: number
  capEnforcement: {
    /** The ledger refused a run one microusd over what the total still allowed. */
    ledgerProbe: "refused_over_cap" | "not_reached"
    rule: string
  }
  providers: LiveProviderListing[]
  fixtureRoot: string | null
  network: { mode: "blocked" | "observed"; requests: number; blocked: number }
  cases: LiveCaseReport[]
  capabilities: CapabilityRow[]
}

export const SIMULATED_DISCLAIMER =
  "SIMULATED: every model answer came from the deterministic Fake Provider and every price from the mock rate cards. This report makes no claim about real quality, latency, cost or savings (EVAL-04)."
export const LIVE_DISCLAIMER =
  "LIVE: every call went to a real provider the user confirmed, reserved and settled by the Router + Fusion ledger under a hard total cap."

export function disclaimerFor(label: LiveSmokeLabel): string {
  return label === "simulated" ? SIMULATED_DISCLAIMER : LIVE_DISCLAIMER
}

export const CAP_ENFORCEMENT_RULE =
  "Each run is created against a tenant limit of (total cap - spend booked in this smoke's own ledger); the ledger refuses a run whose cap does not fit before anything is sent."

export function emptyUsage(): UsageBuckets {
  return {
    inputUncached: 0,
    inputCacheRead: 0,
    inputCacheWrite5m: 0,
    inputCacheWrite1h: 0,
    output: 0,
    reasoning: 0,
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The buckets of a stored usage record. The ledger stores the normalized
 * usage; a record it could not normalize (`{ raw }`) has no buckets and is
 * reported as such rather than guessed.
 */
export function usageBucketsOf(stored: Record<string, unknown> | null): {
  usage: UsageBuckets | null
  reasoningIncludedInOutput: boolean | null
} {
  if (!stored || typeof stored.input_uncached_tokens !== "number") {
    return { usage: null, reasoningIncludedInOutput: null }
  }
  return {
    usage: {
      inputUncached: count(stored.input_uncached_tokens),
      inputCacheRead: count(stored.input_cache_read_tokens),
      inputCacheWrite5m: count(stored.input_cache_write_5m_tokens),
      inputCacheWrite1h: count(stored.input_cache_write_1h_tokens),
      output: count(stored.output_tokens),
      reasoning: count(stored.reasoning_tokens),
    },
    reasoningIncludedInOutput:
      typeof stored.reasoning_included_in_output === "boolean"
        ? stored.reasoning_included_in_output
        : null,
  }
}

export function addUsage(a: UsageBuckets, b: UsageBuckets | null): UsageBuckets {
  if (!b) return a
  return {
    inputUncached: a.inputUncached + b.inputUncached,
    inputCacheRead: a.inputCacheRead + b.inputCacheRead,
    inputCacheWrite5m: a.inputCacheWrite5m + b.inputCacheWrite5m,
    inputCacheWrite1h: a.inputCacheWrite1h + b.inputCacheWrite1h,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  }
}

/**
 * The ledger's attempts joined with the executor's observations, by attempt
 * id. `unledgeredCalls` counts observed calls whose attempt id the ledger
 * never recorded — every call is supposed to be reserved first.
 */
export function callRecordsOf(
  attempts: readonly AttemptLike[],
  observed: readonly ObservedCall[]
): { calls: LiveCallRecord[]; unledgeredCalls: number } {
  const byAttempt = new Map(observed.map((call) => [call.attemptId, call]))
  const known = new Set(attempts.map((attempt) => attempt.attemptId))
  const calls = attempts.map((attempt): LiveCallRecord => {
    const seen = byAttempt.get(attempt.attemptId)
    const { usage, reasoningIncludedInOutput } = usageBucketsOf(attempt.usage)
    return {
      attemptId: attempt.attemptId,
      logicalStepId: attempt.logicalStepId,
      attemptNo: attempt.attemptNo,
      role: attempt.role,
      deploymentId: attempt.deploymentId,
      state: attempt.state,
      providerRequestId: attempt.providerRequestId ?? seen?.providerRequestId ?? null,
      actualMicrousd: attempt.actualMicrousd,
      costStatus: attempt.costStatus,
      errorClass: attempt.errorClass ?? seen?.errorClass ?? null,
      usage,
      reasoningIncludedInOutput,
      latencyMs: seen?.latencyMs ?? null,
      retryAfterMs: seen?.retryAfterMs ?? null,
      finishReason: seen?.finishReason ?? null,
    }
  })
  return {
    calls,
    unledgeredCalls: observed.filter((call) => !known.has(call.attemptId)).length,
  }
}

export function summarizeRetries(
  calls: readonly LiveCallRecord[],
  observed: { executorCalls: number; unledgeredCalls: number; httpRequests: number | null }
): RetrySummary {
  const bySteps = new Map<string, LiveCallRecord[]>()
  for (const call of calls) {
    const list = bySteps.get(call.logicalStepId) ?? []
    list.push(call)
    bySteps.set(call.logicalStepId, list)
  }
  const retriedSteps = [...bySteps.entries()]
    .filter(([, attempts]) => attempts.length > 1)
    .map(([logicalStepId, attempts]) => ({
      logicalStepId,
      attempts: attempts.length,
      errorClasses: attempts
        .filter((attempt) => attempt.errorClass !== null)
        .map((attempt) => attempt.errorClass as string),
    }))
  return {
    logicalSteps: bySteps.size,
    ledgerAttempts: calls.length,
    retriedSteps,
    executorCalls: observed.executorCalls,
    unledgeredCalls: observed.unledgeredCalls,
    httpRequests: observed.httpRequests,
    extraHttpRequests:
      observed.httpRequests === null
        ? null
        : Math.max(0, observed.httpRequests - observed.executorCalls),
    retryAfterMs: calls
      .map((call) => call.retryAfterMs)
      .filter((value): value is number => value !== null),
  }
}

const BUCKET_NAMES: Array<keyof UsageBuckets> = [
  "inputUncached",
  "inputCacheRead",
  "inputCacheWrite5m",
  "inputCacheWrite1h",
  "output",
  "reasoning",
]

/** Per deployment: what the provider reported across every case. */
export function capabilityMatrix(cases: readonly LiveCaseReport[]): CapabilityRow[] {
  const rows = new Map<string, LiveCallRecord[]>()
  for (const call of cases.flatMap((entry) => entry.calls)) {
    const list = rows.get(call.deploymentId) ?? []
    list.push(call)
    rows.set(call.deploymentId, list)
  }
  return [...rows.entries()]
    .map(([deploymentId, calls]): CapabilityRow => {
      const withIds = calls.filter((call) => call.providerRequestId).length
      const buckets = BUCKET_NAMES.filter((name) =>
        calls.some((call) => (call.usage?.[name] ?? 0) > 0)
      )
      const included = calls.find((call) => call.reasoningIncludedInOutput !== null)
      return {
        deploymentId,
        providerId: providerOfDeployment(deploymentId),
        calls: calls.length,
        succeeded: calls.filter((call) => call.state === "SUCCEEDED").length,
        requestIds: withIds === calls.length ? "all" : withIds === 0 ? "none" : "some",
        usageBuckets: buckets,
        reasoningIncludedInOutput: included?.reasoningIncludedInOutput ?? null,
        retryAfterSeen: calls.some((call) => call.retryAfterMs !== null),
        errorClasses: [
          ...new Set(
            calls.map((call) => call.errorClass).filter((value): value is string => value !== null)
          ),
        ],
      }
    })
    .sort((a, b) => a.deploymentId.localeCompare(b.deploymentId))
}

export function totalSpent(cases: readonly LiveCaseReport[]): Microusd {
  return addMicrousd(...cases.map((entry) => entry.spentMicrousd))
}

export const ANSWER_PREVIEW_CHARS = 280

export function answerPreview(answer: string, max = ANSWER_PREVIEW_CHARS): string {
  const flat = answer.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 0 when every case ended as it should (succeeded, or skipped by the router); 1 otherwise. */
export function liveSmokeExitCode(report: LiveSmokeReport): 0 | 1 {
  return report.cases.every((entry) => entry.outcome === "succeeded" || entry.outcome === "skipped")
    ? 0
    : 1
}

// ── Markdown ──────────────────────────────────────────────────────────────────

function cell(value: unknown): string {
  const text = value === null || value === undefined || value === "" ? "—" : String(value)
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ")
}

function row(values: unknown[]): string {
  return `| ${values.map(cell).join(" | ")} |`
}

function table(headers: string[], rows: unknown[][]): string[] {
  return [row(headers), `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map(row)]
}

function usageCell(usage: UsageBuckets | null): string {
  if (!usage) return "not reported"
  return `${usage.inputUncached}/${usage.inputCacheRead}/${usage.inputCacheWrite5m + usage.inputCacheWrite1h}/${usage.output}/${usage.reasoning}`
}

function money(value: number | null): string {
  return value === null ? "—" : formatUsd(value)
}

function caseSection(entry: LiveCaseReport): string[] {
  const lines = [`### ${entry.id}: ${entry.title}`, ""]
  lines.push(`- Outcome: **${entry.outcome}**: ${entry.detail}`)
  if (entry.runId) lines.push(`- Run: \`${entry.runId}\``)
  lines.push(
    `- Money: cap ${formatUsd(entry.capMicrousd)}, spent ${formatUsd(entry.spentMicrousd)}, overspend ${formatUsd(entry.overspendMicrousd)}, cost status ${entry.costStatus ?? "—"}`
  )
  if (entry.route) {
    const roles = Object.entries(entry.route.roles)
      .map(([role, deployment]) => `${role}=\`${deployment}\``)
      .join(", ")
    lines.push(
      `- Route: \`${entry.route.actionId}\` (rule ${entry.route.ruleId ?? "—"}), ${roles}, reserve ${money(entry.route.reserveMicrousd)}`
    )
  }
  if (entry.reasons.length > 0) lines.push(`- Reasons: ${entry.reasons.join(", ")}`)
  if (entry.result) {
    lines.push(
      `- Result: quality ${entry.result.qualityStatus}, verification ${entry.result.verificationStatus}, warnings ${entry.result.warnings.join(", ") || "none"}`
    )
    lines.push(`- Answer (${entry.result.answerChars} chars): ${entry.result.answerPreview}`)
  }
  if (entry.error) lines.push(`- Error: ${entry.error.code}: ${entry.error.message}`)
  const retry = entry.retry
  lines.push(
    `- Retries: ${retry.logicalSteps} step(s), ${retry.ledgerAttempts} ledger attempt(s), ${retry.executorCalls} executor call(s), ${retry.unledgeredCalls} unledgered, HTTP requests ${retry.httpRequests ?? "not observed"}${retry.extraHttpRequests ? ` (${retry.extraHttpRequests} beyond one per call)` : ""}; retried steps: ${
      retry.retriedSteps.length > 0
        ? retry.retriedSteps
            .map(
              (step) => `${step.logicalStepId}×${step.attempts} [${step.errorClasses.join(", ")}]`
            )
            .join("; ")
        : "none"
    }`
  )
  if (entry.calls.length > 0) {
    lines.push("")
    lines.push(
      ...table(
        [
          "Step",
          "#",
          "Role",
          "Deployment",
          "State",
          "Request id",
          "Cost",
          "Usage in/cache-read/cache-write/out/reasoning",
          "Latency ms",
        ],
        entry.calls.map((call) => [
          call.logicalStepId,
          call.attemptNo,
          call.role,
          call.deploymentId,
          call.errorClass ? `${call.state} (${call.errorClass})` : call.state,
          call.providerRequestId,
          call.actualMicrousd === null
            ? "—"
            : `${formatUsd(call.actualMicrousd)} ${call.costStatus ?? ""}`.trim(),
          usageCell(call.usage),
          call.latencyMs,
        ])
      )
    )
  }
  lines.push("")
  return lines
}

export function renderLiveSmokeMarkdown(report: LiveSmokeReport): string {
  const label = report.label === "simulated" ? "SIMULATED" : "LIVE"
  const lines: string[] = [
    `# Router + Fusion live smoke: ${label}`,
    "",
    `> ${report.disclaimer}`,
    "",
    ...table(
      ["Field", "Value"],
      [
        ["Label", report.label],
        ["Generated", report.generatedAt],
        ["Budget mode", report.budgetMode],
        ["Total cap (ledger-enforced)", formatUsd(report.totalCapMicrousd)],
        ["Planned case caps", formatUsd(report.plannedMicrousd)],
        ["Spent", formatUsd(report.totalSpentMicrousd)],
        ["Remaining", formatUsd(report.remainingMicrousd)],
        [
          "Cap probe",
          report.capEnforcement.ledgerProbe === "refused_over_cap"
            ? "the ledger refused a run over the remaining total (TENANT_BUDGET_EXHAUSTED)"
            : "not reached (no case was routed)",
        ],
        [
          "Network",
          `${report.network.mode}: ${report.network.requests} request(s), ${report.network.blocked} blocked`,
        ],
        ["Fixture repository", report.fixtureRoot],
      ]
    ),
    "",
    `Cap rule: ${report.capEnforcement.rule}`,
    "",
    "## Providers",
    "",
    ...table(
      ["Provider", "Kind", "Enabled", "Credential", "Selected"],
      report.providers.map((provider) => [
        provider.id,
        provider.kind,
        provider.enabled ? "yes" : "no",
        provider.credentialEnv
          ? `${provider.credentialEnv} (${provider.credentialFound ? "found" : "missing"})`
          : "not needed",
        provider.selected ? "yes" : "no",
      ])
    ),
    "",
    "## Cases",
    "",
    ...table(
      ["Case", "Mode", "Outcome", "Cap", "Spent", "Calls", "Quality"],
      report.cases.map((entry) => [
        entry.id,
        entry.mode,
        entry.outcome,
        formatUsd(entry.capMicrousd),
        formatUsd(entry.spentMicrousd),
        entry.calls.length,
        entry.result?.qualityStatus,
      ])
    ),
    "",
    ...report.cases.flatMap(caseSection),
    "## Provider capability matrix",
    "",
    ...(report.capabilities.length > 0
      ? table(
          [
            "Deployment",
            "Calls",
            "Succeeded",
            "Request ids",
            "Usage buckets reported",
            "Reasoning inside output",
            "retry-after seen",
            "Error classes",
          ],
          report.capabilities.map((capability) => [
            capability.deploymentId,
            capability.calls,
            capability.succeeded,
            capability.requestIds,
            capability.usageBuckets.join(", "),
            capability.reasoningIncludedInOutput === null
              ? "not reported"
              : capability.reasoningIncludedInOutput
                ? "yes"
                : "no",
            capability.retryAfterSeen ? "yes" : "no",
            capability.errorClasses.join(", "),
          ])
        )
      : ["No provider was called."]),
    "",
  ]
  return lines.join("\n")
}
