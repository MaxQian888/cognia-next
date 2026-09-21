/**
 * Production appliers for the fusion outbox: they write into the account
 * database. Each is idempotent by construction — the usage row is keyed by a
 * deterministic message id (`commitUsageRow` replaces in place), the journal
 * event carries the effect id as its source id (`runEventJournal` dedupes), and
 * a session message has an id derived from its run (`session-transcript.ts`).
 */

import type { UIMessage } from "ai"

import {
  createExecutionRun,
  getExecutionRun,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { commitMessageDelta } from "@/lib/db/messages"
import { getDb } from "@/lib/db/schema"
import { getSession } from "@/lib/db/sessions"
import type { SessionUsageRow, UsageSurface } from "@/lib/db/session-usage"
import { commitUsageRow } from "@/lib/usage/usage-ledger"

import type { OutboxAppliers } from "./outbox"
import { applySessionMessage } from "./session-transcript"
import type { FusionOutboxRow, FusionRunOrigin } from "./types"
import type { ExecutionRunInterrupt, ExecutionRunOrigin, RunEventType } from "@/types/execution/run"

const SURFACE_BY_ORIGIN: Record<FusionRunOrigin, UsageSurface> = {
  chat: "chat",
  gateway: "gateway",
  gatewayPassthrough: "gateway",
  agent: "agent-team",
  workflow: "workflow",
  utility: "memory",
  companion: "chat",
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** Build the account-database usage row a settled fusion call projects to. */
export function usageRowFromOutbox(row: FusionOutboxRow): SessionUsageRow | null {
  const p = row.payload as {
    runId: string
    attemptId: string
    origin: FusionRunOrigin
    sessionId: string | null
    providerId: string | null
    modelId: string | null
    costMicrousd: number
    costStatus: "actual" | "estimated" | "pending"
    usage: Record<string, unknown> | null
    settledAt: number
  }
  if (!p.runId || !p.attemptId) return null
  const usage = p.usage ?? {}
  const cacheWrite5m = num(usage.input_cache_write_5m_tokens)
  const cacheWrite1h = num(usage.input_cache_write_1h_tokens)
  const cacheRead = num(usage.input_cache_read_tokens)
  const uncached = num(usage.input_uncached_tokens)
  const reasoning = num(usage.reasoning_tokens)
  const output =
    num(usage.output_tokens) + (usage.reasoning_included_in_output === false ? reasoning : 0)
  return {
    messageId: `rf:${p.runId}:${p.attemptId}`,
    sessionId: p.sessionId ?? `rf:${p.runId}`,
    at: p.settledAt,
    ...(p.modelId ? { model: p.modelId } : {}),
    ...(p.providerId ? { providerId: p.providerId } : {}),
    inputTokens: uncached + cacheRead + cacheWrite5m + cacheWrite1h,
    outputTokens: output,
    cacheCreationTokens: cacheWrite5m + cacheWrite1h,
    cacheReadTokens: cacheRead,
    ...(cacheWrite5m > 0 ? { cacheCreation5mTokens: cacheWrite5m } : {}),
    ...(cacheWrite1h > 0 ? { cacheCreation1hTokens: cacheWrite1h } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    costUsd: p.costMicrousd / 1_000_000,
    durationMs: 0,
    surface: SURFACE_BY_ORIGIN[p.origin] ?? "chat",
    runId: p.runId,
    attemptId: p.attemptId,
    costSource: "ledger",
    // An estimate is a conservative figure the budget must count, not "unknown".
    costKnown: true,
  }
}

interface ProjectionPayload {
  runId: string
  phase: "queued" | "running" | "waiting" | "terminal"
  origin: ExecutionRunOrigin
  title: string | null
  sessionId: string | null
  actorKeyId: string | null
  actorKeyName: string | null
  mode: string
  actionId: string
  createdAt: number
  status?: string
  errorCode?: string
  /**
   * The decision a parked run is waiting on (`phase: "waiting"`, ADR-0188 B4).
   *
   * `id` is the fusion approval's own id, which is derived from the request
   * digest, so the interrupt id a surface sends back when a person approves
   * names exactly what was approved (API-08). `summary` is paths and counts;
   * no file content and no model text ever travels here.
   */
  interrupt?: {
    id: string
    type: ExecutionRunInterrupt["type"]
    requestDigest?: string
    kind: string
    revision: string
    logicalStepId: string
    summary: Record<string, unknown>
    expiresAt: number
  }
}

const TERMINAL_EVENT: Record<string, RunEventType> = {
  succeeded: "run.completed",
  failed: "run.failed",
  cancelled: "run.cancelled",
  expired: "run.failed",
}

/** The execution-run row a projected fusion run gets the first time it is seen. */
export function projectedExecutionRun(p: ProjectionPayload) {
  return {
    id: p.runId,
    kind: "fusion" as const,
    // The fusion run IS the source: no engine run stands behind it.
    sourceId: p.runId,
    ...(p.sessionId ? { sessionId: p.sessionId } : {}),
    title: p.title || p.actionId,
    status: "queued" as const,
    currentRevision: 0,
    startedAt: p.createdAt,
    updatedAt: p.createdAt,
    origin: p.origin,
    ...(p.actorKeyId
      ? { originActor: { keyId: p.actorKeyId, keyName: p.actorKeyName ?? "" } }
      : {}),
  }
}

export const accountDatabaseAppliers: OutboxAppliers = {
  session_message(row, context) {
    return applySessionMessage(row, context, {
      getSession,
      getMessages: (ids) => getDb().messages.bulkGet(ids),
      commit: (sessionId, upserts) =>
        commitMessageDelta(sessionId, { upserts: upserts as unknown as UIMessage[] }),
    })
  },
  async usage_row(row) {
    const usageRow = usageRowFromOutbox(row)
    if (!usageRow) return "skipped"
    await commitUsageRow(usageRow)
    return "applied"
  },
  async execution_run_projection(row) {
    const p = row.payload as unknown as ProjectionPayload
    if (!p.runId) return "skipped"
    // Create-then-advance, both idempotent: a replay after a partial apply
    // finds the row and only re-appends the event, which the journal dedupes on
    // `sourceEventId`.
    const existing = await getExecutionRun(p.runId)
    if (!existing) await createExecutionRun(projectedExecutionRun(p))
    // A sealed run's history is final (`appendInsideTransaction` refuses every
    // event past a terminal status). Two effects written in the same
    // millisecond can be drained out of order, so an earlier phase arriving
    // after the seal is skipped rather than retried forever.
    else if (["completed", "failed", "cancelled"].includes(existing.status)) return "skipped"
    if (p.phase === "queued") return "applied"
    if (p.phase === "waiting") {
      if (!p.interrupt) return "skipped"
      // `createRunInterrupt` appends `interrupt.requested`, which is what moves
      // the run to `waiting` and makes the cockpit offer approve/deny
      // (`allowedActions` in `lib/execution/run-reducer.ts`). Replaying an
      // effect must not raise a second interrupt for the same decision, so the
      // id — derived from the digest — is checked first.
      const { createRunInterrupt } = await import("@/lib/execution/run-control")
      const existingInterrupt = await getDb().executionRunInterrupts.get(p.interrupt.id)
      if (existingInterrupt) return "applied"
      await createRunInterrupt({
        id: p.interrupt.id,
        runId: p.runId,
        type: p.interrupt.type,
        status: "pending",
        title: "Router + Fusion approval",
        ...(p.interrupt.requestDigest ? { requestDigest: p.interrupt.requestDigest } : {}),
        subject: {
          kind: p.interrupt.kind,
          revision: p.interrupt.revision,
          logicalStepId: p.interrupt.logicalStepId,
          ...p.interrupt.summary,
        },
        expiresAt: p.interrupt.expiresAt,
        createdAt: Date.now(),
      })
      return "applied"
    }
    const type: RunEventType =
      p.phase === "running" ? "run.started" : (TERMINAL_EVENT[p.status ?? ""] ?? "run.failed")
    await runEventJournal.append(
      p.runId,
      semanticRunEvent(
        type,
        {
          routerFusion: {
            mode: p.mode,
            actionId: p.actionId,
            origin: p.origin,
            ...(p.errorCode ? { errorCode: p.errorCode } : {}),
          },
        },
        { sourceEventId: row.effectId }
      )
    )
    return "applied"
  },
  async execution_run_milestone(row) {
    const p = row.payload as Record<string, unknown> & { runId: string; status: string }
    const run = await getExecutionRun(p.runId)
    // The execution run belongs to the surface: when it does not exist or is
    // already sealed there is nothing to annotate; the ledger stays authoritative.
    if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return "skipped"
    await runEventJournal.append(
      p.runId,
      semanticRunEvent(
        "milestone.created",
        {
          milestoneId: row.effectId,
          title: "Router + Fusion settled",
          safeTitle: true,
          routerFusion: {
            status: p.status,
            actionId: p.actionId,
            mode: p.mode,
            ruleId: p.ruleId,
            spentMicrousd: p.spentMicrousd,
            overspendMicrousd: p.overspendMicrousd,
            costStatus: p.costStatus,
            modelCalls: p.modelCalls,
            ...(p.errorCode ? { errorCode: p.errorCode } : {}),
          },
        },
        { sourceEventId: row.effectId }
      )
    )
    return "applied"
  },
}
