// Work-unit efficiency metrics (ADR-0165 Phase 3).
//
// `lib/analysis/session-report.ts` answers "how healthy was this ONE session".
// This module answers the question above it: what did a unit of work cost,
// where a unit is a root run plus every child it spawned, and how much of that
// cost was spent getting the same turn right twice.
//
// It is deliberately computable from the ledger alone, with messages, tool
// counts and adoption rows as OPTIONAL enrichment. That is what lets it run
// over an external agent's imported history, where there are no live tool
// spans and no Task Workspace evidence, without pretending otherwise: every
// metric that needs evidence we do not have reports `null` and names the
// reason, rather than reporting a zero that reads like a measurement.

import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import type { SessionUsageRow } from "@/lib/db/session-usage"

import { effectiveCostUsdDetailed, type PricingResolver } from "./session-analytics"
import { resolveModelPricingUsd } from "./pricing"

/**
 * Bumped when a classifier or a metric definition changes.
 *
 * Persisted on rows as `analysisVersion`, so a detector change can invalidate
 * its own derived verdicts without touching the money beside them.
 */
export const WORK_UNIT_ANALYSIS_VERSION = 1

/**
 * What kind of work a unit was, from deterministic signals only.
 *
 * No model is asked. A classifier that called an LLM would make the cost
 * report itself cost money, and would return a different answer on a re-run
 * over identical data, which is disqualifying for a number people compare
 * across weeks.
 */
export type WorkUnitTaskClass =
  /** Wrote code. Adoption rows or edit-shaped tool calls. */
  | "edit"
  /** Read code without writing. Search and read tools only. */
  | "explore"
  /** Ran things and reacted. Shell-heavy with edits interleaved. */
  | "debug"
  /** Delegated to subagents or teammates more than it worked directly. */
  | "delegate"
  /** Non-code metered work: embeddings, OCR, TTS, twin distillation. */
  | "chore"
  /** Not enough signal to say. Never guessed. */
  | "unknown"

/** Why a metric could not be computed, in a form the UI can translate. */
export type MetricGap =
  /** The rows carry no turn/attempt identity, so retries are invisible. */
  | "noAttemptIdentity"
  /** No workspace recorded what the unit wrote. */
  | "noAdoptionEvidence"
  /** Nothing in the window could be priced. */
  | "noPricing"
  /** The caller supplied no tool observations. */
  | "noToolObservations"

export interface WorkUnitMetrics {
  analysisVersion: number
  taskClass: WorkUnitTaskClass
  /** Which inputs were missing, so a reader can tell absent from zero. */
  gaps: MetricGap[]

  /** Billed rows in the unit, including retries. */
  turns: number
  /** Distinct logical turns, when attempt identity exists. */
  logicalTurns: number | null
  /** Billed rows beyond the first attempt of each logical turn. */
  retries: number | null
  /** Share of logical turns that landed on the first attempt, 0-1. */
  oneShotRate: number | null

  knownCostUsd: number
  unpricedTurns: number
  /** Spend on retries. The clearest single number for "what waste cost me". */
  retryCostUsd: number | null

  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Cache reads as a share of all prompt tokens, 0-1, or null with no prompt. */
  cacheEfficiency: number | null

  /** Share of billed rows served by a delegated surface, 0-1. */
  delegationRate: number
  distinctModels: number
  /** Model changes between consecutive rows in time order. */
  modelSwitches: number

  /** Files the unit touched, per adoption evidence. */
  editedFiles: number | null
  addedLines: number | null
  removedLines: number | null
  costPerEditedFileUsd: number | null

  /** Wall-clock span of the unit's billed rows, seconds. */
  durationSeconds: number
}

export interface WorkUnitInput {
  /** Every billed row in the unit: the root run and its children. */
  rows: readonly SessionUsageRow[]
  /** Adoption rows for the same unit, when a workspace recorded any. */
  adoption?: readonly CodeAdoptionTurnRow[]
  /** Tool name to call count, when the caller observed the unit live. */
  toolCounts?: Record<string, number>
  resolve?: PricingResolver
}

/** Surfaces that mean "this turn was run by something the unit delegated to". */
const DELEGATED_SURFACES = new Set(["subagent", "agent-team"])

/** Surfaces that are metered work but not conversation. */
const CHORE_SURFACES = new Set(["embedding", "twin", "memory", "ocr", "tts", "web-search"])

const EDIT_TOOLS = ["edit", "write", "multiedit", "notebookedit", "apply_patch", "str_replace"]
const SHELL_TOOLS = ["bash", "shell", "run_command", "terminal", "exec"]
const READ_TOOLS = ["read", "grep", "glob", "search", "ls", "find", "webfetch"]

function countMatching(counts: Record<string, number>, names: readonly string[]): number {
  let total = 0
  for (const [tool, n] of Object.entries(counts)) {
    const lowered = tool.toLowerCase()
    if (names.some((name) => lowered.includes(name))) total += n
  }
  return total
}

/**
 * Classify a work unit from deterministic signals.
 *
 * Adoption evidence outranks tool counts: a unit that demonstrably wrote files
 * was an edit whatever its tool mix looked like. Delegation outranks both,
 * because a unit whose cost is mostly its children is best understood as
 * orchestration rather than as whatever the children happened to do.
 */
export function classifyWorkUnit(input: {
  rows: readonly SessionUsageRow[]
  adoption?: readonly CodeAdoptionTurnRow[]
  toolCounts?: Record<string, number>
}): WorkUnitTaskClass {
  const { rows } = input
  if (rows.length === 0) return "unknown"

  const delegated = rows.filter((r) => DELEGATED_SURFACES.has(r.surface ?? "chat")).length
  if (delegated > rows.length / 2) return "delegate"

  if (rows.every((r) => CHORE_SURFACES.has(r.surface ?? "chat"))) return "chore"

  const wrote = (input.adoption ?? []).some((a) => a.totalFiles > 0)
  const counts = input.toolCounts
  if (!counts) return wrote ? "edit" : "unknown"

  const edits = countMatching(counts, EDIT_TOOLS)
  const shells = countMatching(counts, SHELL_TOOLS)
  const reads = countMatching(counts, READ_TOOLS)
  if (wrote || edits > 0) {
    // Shell-heavy work that also edits is debugging: running something,
    // reacting to it, running it again. Editing without that loop is a plain
    // edit, whatever else it read along the way.
    return shells > edits * 2 ? "debug" : "edit"
  }
  if (reads > 0) return "explore"
  if (shells > 0) return "debug"
  return "unknown"
}

/**
 * Group rows into logical turns using ADR-0090 execution identity.
 *
 * Returns `null` when the rows carry no `turnId`, which is the honest answer
 * for an imported transcript. Reporting "0 retries" there would be a
 * measurement claim about data that cannot support one.
 */
export function groupLogicalTurns(
  rows: readonly SessionUsageRow[]
): Map<string, SessionUsageRow[]> | null {
  if (!rows.some((r) => r.turnId)) return null
  const groups = new Map<string, SessionUsageRow[]>()
  for (const row of rows) {
    // A row with identity groups by it. A row without falls back to its own
    // message id, so it counts as one logical turn rather than merging with
    // every other identity-less row into a fake pile of retries.
    const key = row.turnId ? `${row.runId ?? ""}|${row.turnId}` : `solo|${row.messageId}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  return groups
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

/** Compute every work-unit metric that the supplied evidence supports. */
export function analyzeWorkUnit(input: WorkUnitInput): WorkUnitMetrics {
  const resolve = input.resolve ?? resolveModelPricingUsd
  const rows = [...input.rows].sort((a, b) => a.at - b.at)
  const gaps: MetricGap[] = []

  let knownCostUsd = 0
  let unpricedTurns = 0
  const costByMessage = new Map<string, number>()
  for (const row of rows) {
    const cost = effectiveCostUsdDetailed(row, resolve)
    if (cost.known) {
      knownCostUsd += cost.cost
      costByMessage.set(row.messageId, cost.cost)
    } else {
      unpricedTurns += 1
      costByMessage.set(row.messageId, 0)
    }
  }
  if (rows.length > 0 && unpricedTurns === rows.length) gaps.push("noPricing")

  const groups = groupLogicalTurns(rows)
  let logicalTurns: number | null = null
  let retries: number | null = null
  let oneShotRate: number | null = null
  let retryCostUsd: number | null = null
  if (groups) {
    logicalTurns = groups.size
    retries = rows.length - groups.size
    let oneShot = 0
    let wasted = 0
    for (const bucket of groups.values()) {
      if (bucket.length === 1) oneShot += 1
      // Every attempt but the last is spend that produced no kept result. The
      // LAST attempt is the one whose output survived, so it is not waste even
      // when it took four tries to get there.
      const ordered = [...bucket].sort((a, b) => a.at - b.at)
      for (const row of ordered.slice(0, -1)) wasted += costByMessage.get(row.messageId) ?? 0
    }
    oneShotRate = groups.size > 0 ? oneShot / groups.size : null
    retryCostUsd = wasted
  } else {
    gaps.push("noAttemptIdentity")
  }

  const inputTokens = sum(rows.map((r) => r.inputTokens ?? 0))
  const outputTokens = sum(rows.map((r) => r.outputTokens ?? 0))
  const cacheReadTokens = sum(rows.map((r) => r.cacheReadTokens ?? 0))
  const cacheCreationTokens = sum(rows.map((r) => r.cacheCreationTokens ?? 0))
  const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens
  const cacheEfficiency = promptTokens > 0 ? cacheReadTokens / promptTokens : null

  const delegated = rows.filter((r) => DELEGATED_SURFACES.has(r.surface ?? "chat")).length
  const models = rows.map((r) => r.model).filter((m): m is string => Boolean(m))
  let modelSwitches = 0
  for (let i = 1; i < models.length; i += 1) {
    if (models[i] !== models[i - 1]) modelSwitches += 1
  }

  const adoption = input.adoption ?? []
  let editedFiles: number | null = null
  let addedLines: number | null = null
  let removedLines: number | null = null
  if (adoption.length > 0) {
    const paths = new Set<string>()
    for (const turn of adoption) for (const file of turn.files) paths.add(file.path)
    editedFiles = paths.size
    addedLines = sum(adoption.map((a) => a.totalAdded))
    removedLines = sum(adoption.map((a) => a.totalRemoved))
  } else {
    gaps.push("noAdoptionEvidence")
  }
  if (!input.toolCounts) gaps.push("noToolObservations")

  const durationSeconds =
    rows.length > 1 ? Math.max(0, (rows[rows.length - 1].at - rows[0].at) / 1000) : 0

  return {
    analysisVersion: WORK_UNIT_ANALYSIS_VERSION,
    taskClass: classifyWorkUnit(input),
    gaps,
    turns: rows.length,
    logicalTurns,
    retries,
    oneShotRate,
    knownCostUsd,
    unpricedTurns,
    retryCostUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheEfficiency,
    delegationRate: rows.length > 0 ? delegated / rows.length : 0,
    distinctModels: new Set(models).size,
    modelSwitches,
    editedFiles,
    addedLines,
    removedLines,
    costPerEditedFileUsd:
      editedFiles != null && editedFiles > 0 && knownCostUsd > 0
        ? knownCostUsd / editedFiles
        : null,
    durationSeconds,
  }
}

/**
 * Split rows into work units by root run.
 *
 * A unit is keyed on `runId` when the rows carry one, and on `sessionId`
 * otherwise. Child runs (subagents, teammates) that reference the parent run
 * fold into it, which is what makes "what did this task cost" include the
 * agents the task spawned rather than only the turns the user typed into.
 */
export function groupWorkUnits(rows: readonly SessionUsageRow[]): Map<string, SessionUsageRow[]> {
  const units = new Map<string, SessionUsageRow[]>()
  for (const row of rows) {
    const key = row.runId ?? row.sessionId
    const bucket = units.get(key)
    if (bucket) bucket.push(row)
    else units.set(key, [row])
  }
  return units
}
