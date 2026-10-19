/**
 * The run's spend, read back from the usage ledger (ADR-0237).
 *
 * Every rollout and model call of a run is booked on the shared usage table
 * under `harness:<runId>`, success or failure, before its result is used. The
 * run's budget ledger is folded from those rows rather than accumulated in
 * memory, so spend survives a crash, a resume and a failed call that never
 * returned its usage, and it is the same figure the Usage tab shows.
 *
 * Operation ids: `harness:<runId>:<label>:<attempt>` for a rollout and
 * `harness:<runId>:<label>:<attempt>:<call>` for an editor, selector or
 * reflector call. Labels may contain `:` (`roll:inv1`), so the numeric tail is
 * peeled from the right.
 */

import type { HarnessBudgetLedger, HarnessStepKind } from "@/types/harness/evolution"

export const HARNESS_USAGE_SURFACE = "harness-evolution"

/** The usage-table grouping key of a run. */
export function runUsageSessionId(runId: string): string {
  return `harness:${runId}`
}

export interface UsageRowLike {
  messageId: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** `false` when no price was known; the cost is then unknown, not zero. */
  costKnown?: boolean
}

export interface ParsedOperation {
  label: string
  attempt: number
  call?: number
}

/** The label, attempt and call of one usage row of `runId`, or `null` for a foreign row. */
export function parseOperationId(messageId: string, runId: string): ParsedOperation | null {
  const prefix = `${HARNESS_USAGE_SURFACE}:harness:${runId}:`
  if (!messageId.startsWith(prefix)) return null
  const parts = messageId.slice(prefix.length).split(":")
  const numeric: number[] = []
  while (parts.length > 1 && numeric.length < 2 && /^\d+$/.test(parts[parts.length - 1])) {
    numeric.unshift(Number(parts.pop()))
  }
  if (numeric.length === 0 || parts.length === 0) return null
  const label = parts.join(":")
  return numeric.length === 2
    ? { label, attempt: numeric[0], call: numeric[1] }
    : { label, attempt: numeric[0] }
}

export interface LabelSpend {
  costUsd: number
  costUnknown: boolean
  inputTokens: number
  outputTokens: number
  modelCalls: number
}

export interface FoldedSpend {
  total: LabelSpend
  byLabel: Map<string, LabelSpend>
  /** Spend per label and attempt, for the worst observed cost of a step. */
  byAttempt: Map<string, LabelSpend>
}

function emptySpend(): LabelSpend {
  return { costUsd: 0, costUnknown: false, inputTokens: 0, outputTokens: 0, modelCalls: 0 }
}

function addRow(into: LabelSpend, row: UsageRowLike, isModelCall: boolean): void {
  const known = row.costKnown !== false
  into.costUsd += known ? row.costUsd : 0
  into.costUnknown ||= !known
  into.inputTokens += row.inputTokens
  into.outputTokens += row.outputTokens
  if (isModelCall) into.modelCalls += 1
}

/** Fold a run's usage rows by label. `kindOf` names the step kind of a label. */
export function foldRunUsage(
  rows: readonly UsageRowLike[],
  runId: string,
  kindOf: (label: string) => HarnessStepKind | undefined
): FoldedSpend {
  const total = emptySpend()
  const byLabel = new Map<string, LabelSpend>()
  const byAttempt = new Map<string, LabelSpend>()
  for (const row of rows) {
    const op = parseOperationId(row.messageId, runId)
    if (!op) continue
    const kind = kindOf(op.label)
    const isModelCall = kind !== undefined && kind !== "rollout"
    addRow(total, row, isModelCall)
    if (!byLabel.has(op.label)) byLabel.set(op.label, emptySpend())
    addRow(byLabel.get(op.label) as LabelSpend, row, isModelCall)
    const key = `${op.label}#${op.attempt}`
    if (!byAttempt.has(key)) byAttempt.set(key, emptySpend())
    addRow(byAttempt.get(key) as LabelSpend, row, isModelCall)
  }
  return { total, byLabel, byAttempt }
}

/**
 * The run's budget ledger from its usage rows and its finished step counts.
 * `maxObservedCostUsd` is the worst single attempt of each step kind, which is
 * what the next step of that kind reserves.
 */
export function ledgerFromUsage(input: {
  rows: readonly UsageRowLike[]
  runId: string
  kindOf: (label: string) => HarnessStepKind | undefined
  finishedRollouts: number
  finishedSessions: number
  startedAt?: number
}): HarnessBudgetLedger {
  const folded = foldRunUsage(input.rows, input.runId, input.kindOf)
  const maxObserved: Partial<Record<HarnessStepKind, number>> = {}
  for (const [key, spend] of folded.byAttempt) {
    const kind = input.kindOf(key.slice(0, key.lastIndexOf("#")))
    if (!kind || spend.costUnknown) continue
    maxObserved[kind] = Math.max(maxObserved[kind] ?? 0, spend.costUsd)
  }
  return {
    costUsd: folded.total.costUsd,
    costUnknown: folded.total.costUnknown,
    inputTokens: folded.total.inputTokens,
    outputTokens: folded.total.outputTokens,
    modelCalls: folded.total.modelCalls,
    rollouts: input.finishedRollouts,
    sessions: input.finishedSessions,
    maxObservedCostUsd: maxObserved,
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
  }
}
