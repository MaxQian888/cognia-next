/**
 * Per-message usage + cost rows. Captured each time the SDK delivers a
 * `result` event by `lib/claude/adapter.ts:applyResultMessage`. The row's
 * primary key is `messageId` (the Anthropic assistant message id), which
 * is unique across all sessions, so the writer is naturally idempotent —
 * re-applying the same result event overwrites in place.
 *
 * Stage 2 of the ClaudeCode 完整化 plan. See docs/content/docs/adr/0010-…
 * for the subscription-quota collector that lives at a different layer
 * (the rate-limit headers emitted by the fetch interceptor); this table
 * captures per-turn data the SDK itself reports.
 */

import { extractUsage } from "@/lib/claude/adapter"
import type { SDKResultMessage } from "@/lib/claude/types"
import { getDb } from "./schema"

/**
 * Which surface produced a usage row. Lets the Subscription → Usage tab show
 * total spend across every LLM-driven surface — not just interactive chat.
 * Legacy rows have no `surface`; readers treat `undefined` as `"chat"`.
 */
export type UsageSurface = "chat" | "workflow" | "agent-team"

/** Persisted per-turn usage. All token fields default to 0 when missing. */
export interface SessionUsageRow {
  /**
   * Primary key, unique across sessions. For chat this is the Anthropic
   * assistant message id; shadow rows use a synthetic deterministic id
   * (`wf:<runId>:<stepId>`, `team:<runId>:<teammateId>:<taskId>`) so retries
   * overwrite in place exactly like the chat path.
   */
  messageId: string
  /**
   * Grouping key for "Top sessions". Chat = ChatSession id; workflow runs use
   * `wf:<runId>`, agent-team runs use `team:<runId>`.
   */
  sessionId: string
  /** Speaking character (team chats only). */
  characterId?: string
  /** Wall-clock ms when the result was recorded. */
  at: number
  /** Resolved model id reported by the SDK on this turn (best-effort). */
  model?: string
  /** Provider that served the turn — drives provider-scoped pricing lookup. */
  providerId?: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  /** USD cost the SDK estimated for this turn. May be 0 when missing. */
  costUsd: number
  /** SDK-reported turn duration. May be 0 when missing. */
  durationMs: number
  /** Producing surface. Absent on legacy rows ⇒ treated as `"chat"`. */
  surface?: UsageSurface
}

/**
 * Insert or replace a single row. Idempotent on `messageId` — the same id
 * always overwrites the same row, so re-emitting a result event during
 * streaming retries doesn't double-count.
 */
export async function upsertSessionUsage(row: SessionUsageRow): Promise<void> {
  if (!row.messageId || !row.sessionId) return
  await getDb().sessionUsage.put(row)
}

/**
 * High-level recorder called from the chat hooks (`use-claude-chat`,
 * `use-team-chat`) when a SDK `result` event lands. Pulls usage out of the
 * SDKResultMessage, builds a row, and upserts. No-ops cleanly when there's
 * nothing useful to record (e.g. error results without usage payloads) so
 * the caller doesn't have to defend.
 *
 * Returns the row that was written (or `null` when nothing was recorded) —
 * mostly so tests can assert against the persisted shape without a second
 * Dexie read.
 */
export async function recordResultUsage(args: {
  sessionId: string
  messageId: string | undefined
  characterId?: string
  model?: string
  providerId?: string
  result: SDKResultMessage
}): Promise<SessionUsageRow | null> {
  const { sessionId, messageId, characterId, model, providerId, result } = args
  if (!sessionId || !messageId) return null
  const usage = extractUsage(result)
  if (!usage) return null
  const row: SessionUsageRow = {
    messageId,
    sessionId,
    characterId,
    at: Date.now(),
    model,
    providerId,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationInputTokens ?? 0,
    cacheReadTokens: usage.cacheReadInputTokens ?? 0,
    costUsd: usage.totalCostUsd ?? 0,
    durationMs: usage.durationMs ?? 0,
    surface: "chat",
  }
  await upsertSessionUsage(row)
  return row
}

/**
 * Fire-and-forget a shadow usage write, swallowing storage errors. Centralizes
 * the "never let the billing mirror fail the caller" rule so producers don't
 * each carry an inline empty `.catch`.
 */
export function swallowUsageWrite(p: Promise<unknown>): void {
  void p.catch(() => {})
}

/** Token shape shared by the workflow + agent-team shadow recorders. */
export interface SurfaceUsageInput {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  model?: string
  providerId?: string
}

const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Build a shadow row, or `null` when there's nothing worth recording. */
function buildSurfaceRow(args: {
  messageId: string
  sessionId: string
  surface: UsageSurface
  usage: SurfaceUsageInput
  at: number
}): SessionUsageRow | null {
  const { usage } = args
  const inputTokens = num(usage.inputTokens)
  const outputTokens = num(usage.outputTokens)
  // Stub / no-op steps (e.g. the ai.prompt echo) report 0/0 — don't pollute
  // the billing table with empty turns.
  if (inputTokens === 0 && outputTokens === 0) return null
  return {
    messageId: args.messageId,
    sessionId: args.sessionId,
    at: args.at,
    model: usage.model,
    providerId: usage.providerId,
    inputTokens,
    outputTokens,
    cacheCreationTokens: num(usage.cacheCreationTokens),
    cacheReadTokens: num(usage.cacheReadTokens),
    costUsd: num(usage.costUsd),
    durationMs: 0,
    surface: args.surface,
  }
}

/**
 * Shadow-write a workflow step's usage into the unified billing table so the
 * Subscription → Usage tab counts workflow spend. Idempotent on
 * `wf:<runId>:<stepId>` — a retried step overwrites its earlier attempt.
 * Fire-and-forget friendly; returns the written row (or `null` when skipped).
 */
export async function recordWorkflowStepUsage(args: {
  runId: string
  stepId: string
  usage: SurfaceUsageInput
  at?: number
}): Promise<SessionUsageRow | null> {
  if (!args.runId || !args.stepId) return null
  const row = buildSurfaceRow({
    messageId: `wf:${args.runId}:${args.stepId}`,
    sessionId: `wf:${args.runId}`,
    surface: "workflow",
    usage: args.usage,
    at: args.at ?? Date.now(),
  })
  if (!row) return null
  await upsertSessionUsage(row)
  return row
}

/**
 * Shadow-write one agent-team teammate turn's usage. Idempotent on
 * `team:<runId>:<teammateId>:<taskId>`. Standalone team runs would otherwise
 * never reach the unified usage tab (they only emit agent-trace spans).
 */
export async function recordTeamUsage(args: {
  runId: string
  teammateId: string
  taskId: string
  usage: SurfaceUsageInput
  at?: number
}): Promise<SessionUsageRow | null> {
  if (!args.runId || !args.teammateId || !args.taskId) return null
  const row = buildSurfaceRow({
    messageId: `team:${args.runId}:${args.teammateId}:${args.taskId}`,
    sessionId: `team:${args.runId}`,
    surface: "agent-team",
    usage: args.usage,
    at: args.at ?? Date.now(),
  })
  if (!row) return null
  await upsertSessionUsage(row)
  return row
}

/** Read all rows for one session, oldest-first (matches the message order). */
export async function listUsageForSession(sessionId: string): Promise<SessionUsageRow[]> {
  return getDb().sessionUsage.where("sessionId").equals(sessionId).sortBy("at")
}

/** Aggregated totals helper. Returns 0 across the board when no rows exist. */
export interface SessionUsageTotals {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
  durationMs: number
  /** Number of turns aggregated. */
  turns: number
  /** Per-model breakdown for the same window. */
  byModel: Record<string, { tokens: number; costUsd: number; turns: number }>
}

const EMPTY_TOTALS: SessionUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  durationMs: 0,
  turns: 0,
  byModel: {},
}

/** Sum the rows for a single session. Cheap — single index range scan. */
export async function totalsBySession(sessionId: string): Promise<SessionUsageTotals> {
  const rows = await listUsageForSession(sessionId)
  return aggregate(rows)
}

/**
 * Sum every row in the table grouped by `sessionId`. Fine on the typical
 * cardinality (≤ low thousands of turns). Used by the Subscription Usage
 * tab's "Top sessions by cost" widget.
 */
export async function totalsByAllSessions(): Promise<Map<string, SessionUsageTotals>> {
  const rows = await getDb().sessionUsage.toArray()
  const grouped = new Map<string, SessionUsageRow[]>()
  for (const r of rows) {
    const list = grouped.get(r.sessionId)
    if (list) list.push(r)
    else grouped.set(r.sessionId, [r])
  }
  const out = new Map<string, SessionUsageTotals>()
  for (const [sid, list] of grouped) out.set(sid, aggregate(list))
  return out
}

/**
 * Top N sessions by cumulative cost. `0` totals are skipped; ties broken by
 * turn count then by sessionId so the order is deterministic in tests.
 */
export async function topByCost(
  limit = 10
): Promise<Array<{ sessionId: string; totals: SessionUsageTotals }>> {
  const map = await totalsByAllSessions()
  const entries: Array<{ sessionId: string; totals: SessionUsageTotals }> = []
  for (const [sessionId, totals] of map) {
    if (totals.costUsd <= 0) continue
    entries.push({ sessionId, totals })
  }
  entries.sort((a, b) => {
    if (b.totals.costUsd !== a.totals.costUsd) return b.totals.costUsd - a.totals.costUsd
    if (b.totals.turns !== a.totals.turns) return b.totals.turns - a.totals.turns
    return a.sessionId.localeCompare(b.sessionId)
  })
  return entries.slice(0, Math.max(0, Math.floor(limit)))
}

/** Drop every row for a session — called when the session itself is deleted. */
export async function deleteUsageForSession(sessionId: string): Promise<void> {
  await getDb().sessionUsage.where("sessionId").equals(sessionId).delete()
}

function aggregate(rows: SessionUsageRow[]): SessionUsageTotals {
  if (rows.length === 0) return { ...EMPTY_TOTALS, byModel: {} }
  const totals: SessionUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    turns: 0,
    byModel: {},
  }
  for (const r of rows) {
    totals.inputTokens += r.inputTokens
    totals.outputTokens += r.outputTokens
    totals.cacheCreationTokens += r.cacheCreationTokens
    totals.cacheReadTokens += r.cacheReadTokens
    totals.costUsd += r.costUsd
    totals.durationMs += r.durationMs
    totals.turns += 1
    const model = r.model ?? "(unknown)"
    const slot = totals.byModel[model] ?? { tokens: 0, costUsd: 0, turns: 0 }
    slot.tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens
    slot.costUsd += r.costUsd
    slot.turns += 1
    totals.byModel[model] = slot
  }
  return totals
}
