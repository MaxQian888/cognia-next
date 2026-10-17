/**
 * Turn what each long-run surface already records into {@link RunSample}s
 * (ADR-0232). Pure: `load-samples.ts` reads the tables and hands them here.
 *
 * Every surface keeps its history somewhere different, so each has its own
 * builder:
 *
 * - **goal**: usage rows under `goal:<goalId>` (one per goal turn), the goal
 *   row for status and lifetime. Goal rows carry no model, so the family comes
 *   from the conversation's own chat rows during the goal's lifetime; a
 *   headless goal has none and lands in the model-agnostic buckets.
 * - **team**: usage rows under `team:<runId>`, the team `ExecutionRun` for
 *   status and duration, child runs for the teammates' runtimes. Best-of-N
 *   groups also run as team runs (`best-of-n:<id>`) and are skipped here.
 * - **best-of-n**: the projected group's candidates. They have no usage rows,
 *   only a frozen dollar figure, so these samples carry no token breakdown and
 *   cannot be re-priced. Each candidate is one sample; a launch multiplies.
 * - **scheduled**: conversations a scheduled task created (`origin.kind ===
 *   "scheduled-task"`), excluding the ones a scheduled goal ran in, which the
 *   goal builder already counts.
 * - **external-session**: imported transcripts, one sample per source session.
 *
 * A goal's interactive turns are also written as chat rows. Those rows are
 * read only to name the model, never summed, so a goal is not counted twice.
 */

import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { AgentTeamChildRun } from "@/types/agent/agent-team-runtime"
import type { BestOfNCandidateStatus, BestOfNRunSummary } from "@/types/best-of-n"
import type { ExecutionRun } from "@/types/execution/run"
import type { Goal, GoalStatus } from "@/types/goal"

import type { RunSample, RunTokenBreakdown } from "./estimate"
import {
  combineHarness,
  externalHarnessKey,
  harnessFromProvider,
  harnessFromTeammateRuntime,
  type ExternalPresetResolver,
} from "./harness"
import { modelFamilyOf } from "./model-family"

/** A conversation a scheduled task created. Only the fields the builder reads. */
export interface ScheduledSessionRef {
  id: string
  origin?: { kind: string }
}

export interface SampleSources {
  /** Usage rows inside the estimate window, local and imported. */
  usageRows: readonly SessionUsageRow[]
  goals: readonly Goal[]
  /** `ExecutionRun`s of kind `team`. */
  teamRuns: readonly ExecutionRun[]
  teamChildRuns: readonly AgentTeamChildRun[]
  bestOfN: readonly BestOfNRunSummary[]
  scheduledSessions: readonly ScheduledSessionRef[]
  resolvePreset: ExternalPresetResolver
}

const GOAL_TERMINAL: ReadonlySet<GoalStatus> = new Set([
  "completed",
  "stopped",
  "budget_limited",
  "turn_limited",
  "timed_out",
  "preempted",
])

const CANDIDATE_TERMINAL: ReadonlySet<BestOfNCandidateStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
])

/** What a set of usage rows adds up to. */
export interface RowSummary {
  tokens: RunTokenBreakdown
  /** The model the rows spent the most tokens on, with its provider. */
  model?: string
  providerId?: string
  firstAt: number
  lastAt: number
  /** Sum of the per-turn durations the providers reported. */
  reportedDurationMs: number
}

function rowTokenTotal(row: SessionUsageRow): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens
}

export function summarizeRows(rows: readonly SessionUsageRow[]): RowSummary | null {
  if (rows.length === 0) return null
  const tokens: RunTokenBreakdown = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  }
  const byModel = new Map<string, { tokens: number; providerId?: string }>()
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = Number.NEGATIVE_INFINITY
  let reportedDurationMs = 0
  for (const row of rows) {
    tokens.input += row.inputTokens
    tokens.output += row.outputTokens
    tokens.cacheRead += row.cacheReadTokens
    const split5m = row.cacheCreation5mTokens ?? 0
    const split1h = row.cacheCreation1hTokens ?? 0
    if (split5m + split1h > 0) {
      tokens.cacheWrite5m += split5m
      tokens.cacheWrite1h += split1h
    } else {
      tokens.cacheWrite += row.cacheCreationTokens
    }
    if (row.model) {
      const entry = byModel.get(row.model) ?? { tokens: 0, providerId: row.providerId }
      entry.tokens += rowTokenTotal(row)
      entry.providerId ??= row.providerId
      byModel.set(row.model, entry)
    }
    firstAt = Math.min(firstAt, row.at)
    lastAt = Math.max(lastAt, row.at)
    reportedDurationMs += row.durationMs > 0 ? row.durationMs : 0
  }
  let model: string | undefined
  let providerId: string | undefined
  let best = -1
  for (const [id, entry] of byModel) {
    if (entry.tokens > best) {
      best = entry.tokens
      model = id
      providerId = entry.providerId
    }
  }
  return { tokens, model, providerId, firstAt, lastAt, reportedDurationMs }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    if (k === undefined) continue
    const bucket = out.get(k)
    if (bucket) bucket.push(item)
    else out.set(k, [item])
  }
  return out
}

function goalSamples(
  goals: readonly Goal[],
  bySession: Map<string, SessionUsageRow[]>,
  resolvePreset: ExternalPresetResolver
): RunSample[] {
  const out: RunSample[] = []
  for (const goal of goals) {
    if (!GOAL_TERMINAL.has(goal.status) || goal.endedAt === undefined) continue
    const summary = summarizeRows(bySession.get(`goal:${goal.id}`) ?? [])
    if (!summary) continue
    const endedAt = goal.endedAt
    const chat = summarizeRows(
      (bySession.get(goal.sessionId) ?? []).filter(
        (row) => !row.imported && row.at >= goal.createdAt && row.at <= endedAt
      )
    )
    out.push({
      surface: "goal",
      harness: chat?.model ? harnessFromProvider(chat.providerId, resolvePreset) : null,
      modelFamily: modelFamilyOf(chat?.model),
      ...(chat?.model ? { model: chat.model } : {}),
      ...(chat?.providerId ? { providerId: chat.providerId } : {}),
      endedAt,
      durationMs: Math.max(0, endedAt - goal.createdAt),
      tokens: summary.tokens,
      frozenCostUsd: null,
      stoppedEarly: goal.status !== "completed",
    })
  }
  return out
}

function teamSamples(
  runs: readonly ExecutionRun[],
  children: readonly AgentTeamChildRun[],
  bySession: Map<string, SessionUsageRow[]>
): RunSample[] {
  const childrenByRun = groupBy(children, (child) => child.runId)
  const out: RunSample[] = []
  for (const run of runs) {
    if (run.kind !== "team" || run.endedAt === undefined) continue
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
      continue
    }
    if (run.sourceId.startsWith("best-of-n:")) continue
    const summary = summarizeRows(bySession.get(`team:${run.sourceId}`) ?? [])
    if (!summary) continue
    const teammates = childrenByRun.get(run.sourceId) ?? []
    out.push({
      surface: "team",
      harness: combineHarness(teammates.map((child) => harnessFromTeammateRuntime(child.runtime))),
      modelFamily: modelFamilyOf(summary.model),
      ...(summary.model ? { model: summary.model } : {}),
      ...(summary.providerId ? { providerId: summary.providerId } : {}),
      endedAt: run.endedAt,
      durationMs: Math.max(0, run.endedAt - run.startedAt),
      tokens: summary.tokens,
      frozenCostUsd: null,
      stoppedEarly: run.status !== "completed",
    })
  }
  return out
}

function bestOfNSamples(
  runs: readonly BestOfNRunSummary[],
  resolvePreset: ExternalPresetResolver
): RunSample[] {
  const out: RunSample[] = []
  for (const run of runs) {
    for (const candidate of run.group.candidates) {
      if (!CANDIDATE_TERMINAL.has(candidate.status) || candidate.finishedAt === null) continue
      out.push({
        surface: "best-of-n",
        harness: harnessFromProvider(candidate.agent.provider, resolvePreset),
        modelFamily: modelFamilyOf(candidate.agent.model),
        ...(candidate.agent.model ? { model: candidate.agent.model } : {}),
        endedAt: candidate.finishedAt,
        durationMs:
          candidate.startedAt !== null
            ? Math.max(0, candidate.finishedAt - candidate.startedAt)
            : null,
        tokens: null,
        frozenCostUsd: candidate.costUsd,
        stoppedEarly: candidate.status !== "succeeded",
      })
    }
  }
  return out
}

/** Wall-clock span of a row set, or the reported turn time when the span is empty. */
function rowsDurationMs(summary: RowSummary): number | null {
  const span = summary.lastAt - summary.firstAt
  if (span > 0) return span
  return summary.reportedDurationMs > 0 ? summary.reportedDurationMs : null
}

function scheduledSamples(
  sessions: readonly ScheduledSessionRef[],
  goalSessionIds: ReadonlySet<string>,
  bySession: Map<string, SessionUsageRow[]>,
  resolvePreset: ExternalPresetResolver
): RunSample[] {
  const out: RunSample[] = []
  for (const session of sessions) {
    if (session.origin?.kind !== "scheduled-task" || goalSessionIds.has(session.id)) continue
    const summary = summarizeRows((bySession.get(session.id) ?? []).filter((r) => !r.imported))
    if (!summary) continue
    out.push({
      surface: "scheduled",
      harness: summary.model ? harnessFromProvider(summary.providerId, resolvePreset) : null,
      modelFamily: modelFamilyOf(summary.model),
      ...(summary.model ? { model: summary.model } : {}),
      ...(summary.providerId ? { providerId: summary.providerId } : {}),
      endedAt: summary.lastAt,
      durationMs: rowsDurationMs(summary),
      tokens: summary.tokens,
      frozenCostUsd: null,
      stoppedEarly: null,
    })
  }
  return out
}

function importedSamples(rows: readonly SessionUsageRow[]): RunSample[] {
  const groups = groupBy(
    rows.filter((row) => row.imported && row.sourceId),
    (row) => `${row.sourceId}\u0000${row.sourceSessionId ?? row.sessionId}`
  )
  const out: RunSample[] = []
  for (const group of groups.values()) {
    const summary = summarizeRows(group)
    if (!summary) continue
    out.push({
      surface: "external-session",
      harness: externalHarnessKey(group[0].sourceId as string),
      modelFamily: modelFamilyOf(summary.model),
      ...(summary.model ? { model: summary.model } : {}),
      ...(summary.providerId ? { providerId: summary.providerId } : {}),
      endedAt: summary.lastAt,
      durationMs: rowsDurationMs(summary),
      tokens: summary.tokens,
      frozenCostUsd: null,
      stoppedEarly: null,
    })
  }
  return out
}

export function buildRunSamples(sources: SampleSources): RunSample[] {
  const bySession = groupBy(sources.usageRows, (row) => row.sessionId)
  const goalSessionIds = new Set(sources.goals.map((goal) => goal.sessionId))
  return [
    ...goalSamples(sources.goals, bySession, sources.resolvePreset),
    ...teamSamples(sources.teamRuns, sources.teamChildRuns, bySession),
    ...bestOfNSamples(sources.bestOfN, sources.resolvePreset),
    ...scheduledSamples(
      sources.scheduledSessions,
      goalSessionIds,
      bySession,
      sources.resolvePreset
    ),
    ...importedSamples(sources.usageRows),
  ]
}
