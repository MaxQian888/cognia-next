/**
 * Execution evidence for one rollout (ADR-0237).
 *
 * Pure assembly: the probe runner gathers the raw facts (the capture stream's
 * trajectory, the files left in the working directory, usage, blocked calls)
 * and this module turns them into the {@link HarnessExecutionEvidence} every
 * later stage reads, and into the markdown files editors are served.
 *
 * Text that leaves a run as evidence is redacted first: a trajectory routinely
 * carries file contents and command output, and evidence is stored and handed
 * to other model calls.
 */

import { redactText } from "@cognia/redact"
import type {
  HarnessBlockedAction,
  HarnessDeliverable,
  HarnessEvolutionTask,
  HarnessExecutionEvidence,
} from "@/types/harness/evolution"
import { checkTally, isDelivered, runTaskChecks, type AcceptanceCheckOutcome } from "./checks"
import { canonicalHash } from "./snapshot"
import { renderTrajectory, type TrajectorySummary } from "./trajectory"

/** Final answer cap kept on the evidence row. */
export const OUTPUT_MAX_CHARS = 32_000
/** Text kept per deliverable. Larger files keep only size and hash. */
export const DELIVERABLE_TEXT_MAX_CHARS = 24_000

export interface TaskInputHashInput {
  prompt: string
  inputFiles?: HarnessEvolutionTask["inputFiles"]
  git?: HarnessEvolutionTask["git"]
  expectedDeliverables?: string[]
  checks: HarnessEvolutionTask["checks"]
}

/**
 * Hash of everything a rollout's outcome depends on from the task side. File
 * contents enter through their recorded SHA-256, the repository through its
 * frozen base commit; host paths do not enter, so the same task moved to
 * another checkout keeps its hash.
 */
export async function taskInputHash(task: TaskInputHashInput): Promise<string> {
  return canonicalHash({
    prompt: task.prompt,
    files: (task.inputFiles ?? [])
      .map((f) => ({ path: f.relativePath, sha256: f.sha256 ?? null }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    git: task.git ? { base: task.git.resolvedBaseSha ?? task.git.baseRef ?? "HEAD" } : null,
    deliverables: [...(task.expectedDeliverables ?? [])].sort(),
    checks: task.checks,
  })
}

export interface EnvironmentFingerprintInput {
  runtimeFingerprint: string
  isolation: HarnessEvolutionTask["isolation"]
  executorProviderId?: string
  executorModel?: string
  maxTurns: number
  probePolicyHash: string
}

/** Hash of the conditions a rollout ran under, beyond the harness and the task. */
export async function environmentFingerprint(input: EnvironmentFingerprintInput): Promise<string> {
  const hash = await canonicalHash(input)
  return `hef1-${hash.slice(0, 32)}`
}

export interface BuildEvidenceInput {
  snapshotId: string
  task: HarnessEvolutionTask
  environmentFingerprint: string
  trajectory: TrajectorySummary
  /** The run's final text when the runtime reported it; else the trajectory's last block. */
  finalText?: string
  deliverables: readonly HarnessDeliverable[]
  filesObservable: boolean
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    totalCostUsd?: number
  }
  latencyMs: number
  blockedActions: readonly HarnessBlockedAction[]
  acceptance?: ReadonlyMap<string, AcceptanceCheckOutcome>
  degraded: boolean
  error?: string
  traceId?: string
}

function capText(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated: ${text.length - max} more chars]`
}

/** Redact credentials and personal data from text that is stored and served to other model calls. */
export function redactEvidenceText(text: string): string {
  return redactText(text).redacted
}

/**
 * Checks run against what the rollout actually produced; only the stored copy
 * is redacted, so a check looking for a number is not defeated by the phone
 * pass of the redactor.
 */
export function buildExecutionEvidence(input: BuildEvidenceInput): HarnessExecutionEvidence {
  const rawOutput = capText(
    (input.finalText ?? input.trajectory.finalText).trim(),
    OUTPUT_MAX_CHARS
  )
  const checkInput = {
    output: rawOutput,
    deliverables: input.deliverables,
    toolFailures: input.trajectory.toolFailures,
    filesObservable: input.filesObservable,
    ...(input.acceptance ? { acceptance: input.acceptance } : {}),
  }
  const validation = runTaskChecks(input.task.checks, checkInput)
  const delivered = isDelivered(input.task, checkInput, input.error)
  return {
    snapshotId: input.snapshotId,
    inputFingerprint: input.task.inputHash,
    environmentFingerprint: input.environmentFingerprint,
    output: redactEvidenceText(rawOutput),
    trajectory: redactEvidenceText(renderTrajectory(input.trajectory.entries)),
    deliverables: input.deliverables.map((d) =>
      d.text === undefined ? { ...d } : { ...d, text: redactEvidenceText(d.text) }
    ),
    metrics: {
      inputTokens: input.usage.inputTokens ?? 0,
      outputTokens: input.usage.outputTokens ?? 0,
      cacheReadTokens: input.usage.cacheReadInputTokens ?? 0,
      ...(typeof input.usage.totalCostUsd === "number"
        ? { costUsd: input.usage.totalCostUsd }
        : {}),
      latencyMs: input.latencyMs,
      toolCalls: input.trajectory.toolCalls,
      toolFailures: input.trajectory.toolFailures,
      steps: input.trajectory.steps,
    },
    validation,
    blockedActions: input.blockedActions.map((b) => ({
      ...b,
      reason: redactEvidenceText(b.reason),
    })),
    delegations: [...input.trajectory.delegations],
    degraded: input.degraded,
    delivered,
    ...(input.error ? { error: redactEvidenceText(input.error) } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
  }
}

/**
 * The deterministic standing of a rollout, for ordering before any judge:
 * delivered first, then fewer failed checks, more passed checks, fewer tool
 * failures. Higher is better. Cost and latency are tie-breakers elsewhere.
 */
export function deterministicStanding(evidence: HarnessExecutionEvidence): number[] {
  const tally = checkTally(evidence.validation)
  return [
    evidence.error ? 0 : 1,
    evidence.delivered ? 1 : 0,
    -tally.failed,
    tally.passed,
    -evidence.metrics.toolFailures,
  ]
}

/** Lexicographic comparison of two standings: positive when `a` is better. */
export function compareStanding(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** `rollouts/<label>.md`: one rollout as an editor reads it. */
export function renderRolloutMarkdown(label: string, evidence: HarnessExecutionEvidence): string {
  const m = evidence.metrics
  const tally = checkTally(evidence.validation)
  const lines = [
    `# Rollout ${label}`,
    "",
    `- delivered: ${evidence.delivered ? "yes" : "no"}`,
    `- checks: ${tally.passed} passed, ${tally.failed} failed, ${tally.inconclusive} inconclusive`,
    `- tool calls: ${m.toolCalls} (${m.toolFailures} failed), steps: ${m.steps}`,
    `- tokens: ${m.inputTokens} in / ${m.outputTokens} out${typeof m.costUsd === "number" ? `, cost $${m.costUsd.toFixed(4)}` : ""}`,
    `- latency: ${Math.round(m.latencyMs / 1000)}s`,
  ]
  if (evidence.degraded) lines.push("- degraded: the run had no tools or no working directory")
  if (evidence.error) lines.push(`- error: ${evidence.error}`)
  if (evidence.validation.length) {
    lines.push("", "## Checks", "")
    for (const v of evidence.validation) {
      lines.push(`- [${v.status}] ${v.check}${v.detail ? ` — ${v.detail}` : ""}`)
    }
  }
  if (evidence.blockedActions.length) {
    lines.push("", "## Blocked by the probe policy", "")
    for (const b of evidence.blockedActions) lines.push(`- ${b.toolName}: ${b.reason}`)
  }
  if (evidence.delegations.length) {
    lines.push("", "## Delegations", "", ...evidence.delegations.map((d) => `- ${d}`))
  }
  lines.push("", "## Final answer", "", evidence.output || "(empty)")
  lines.push("", "## Trajectory", "", evidence.trajectory || "(no steps)")
  return lines.join("\n")
}

/** `deliverables/…/produced.md`: the files a rollout left, as an editor reads them. */
export function renderDeliverablesMarkdown(evidence: HarnessExecutionEvidence): string {
  if (evidence.deliverables.length === 0) return "No files were produced."
  const parts: string[] = []
  for (const d of evidence.deliverables) {
    const head = `## ${d.path} (${d.bytes} bytes${d.truncated ? ", truncated" : ""})`
    parts.push(
      d.text === undefined
        ? `${head}\n\n(binary; sha256 ${d.sha256 ?? "unknown"})`
        : `${head}\n\n${d.text}`
    )
  }
  return parts.join("\n\n")
}
