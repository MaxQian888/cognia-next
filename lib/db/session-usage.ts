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

import { extractUsage, type UsageInfo } from "@/lib/claude/adapter"
import type { SDKResultMessage } from "@cognia/agent-config-types"
import { getDb } from "./schema"
import { commitUsageRow } from "@/lib/usage/usage-ledger"
import { externalTokenUsageToUsageInfo } from "@/lib/claude/usage"
import type { ExternalAgentTokenUsage } from "@/types/agent/external-agent"
import type {
  SessionUsageRow,
  UsageBasis,
  UsageCostSource,
  UsagePriceSnapshot,
  UsageSurface,
  UsageUnitBreakdown,
} from "@cognia/plugin-contract/lib/db/session-usage"
export type {
  SessionUsageRow,
  UsageBasis,
  UsageCostSource,
  UsagePriceSnapshot,
  UsageSurface,
  UsageUnitBreakdown,
} from "@cognia/plugin-contract/lib/db/session-usage"

/** Every metered surface, for exhaustive UI filters. */
export const USAGE_SURFACES: readonly UsageSurface[] = [
  "chat",
  "workflow",
  "agent-team",
  "connector",
  "goal",
  "embedding",
  "twin",
  "memory",
  "eval",
  "subagent",
  "plugin",
  "ocr",
  "tts",
  "web-search",
  "gateway",
  "imported",
  "harness-evolution",
]

/**
 * Insert or replace a single row. Idempotent on `messageId`: the same id
 * always overwrites the same row, so re-emitting a result event during
 * streaming retries doesn't double-count.
 *
 * Every one of the `record*Usage` helpers below funnels through here, and here
 * funnels through `commitUsageRow` (ADR-0165), which freezes the cost and
 * commits the `providerCostDaily` DELTA in the same transaction. That is the
 * only reason the ledger and the budget projection can be asserted equal:
 * there is exactly one writer, and an overwrite retracts what it replaces.
 */
export async function upsertSessionUsage(row: SessionUsageRow): Promise<void> {
  await commitUsageRow(row)
}

/** Persist the same reported accounting attached to an external assistant turn. */
export async function recordExternalAgentUsage(args: {
  sessionId: string
  messageId: string
  usage: ExternalAgentTokenUsage
  model?: string
  durationMs?: number
  at?: number
}): Promise<void> {
  const usage = externalTokenUsageToUsageInfo(args.usage)
  const costKnown = usage.totalCostUsd !== undefined
  await upsertSessionUsage({
    sessionId: args.sessionId,
    messageId: args.messageId,
    model: args.model,
    at: args.at ?? Date.now(),
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadInputTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationInputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens,
    costUsd: usage.totalCostUsd ?? 0,
    costKnown,
    costSource: costKnown ? "sdk" : "unknown",
    durationMs: args.durationMs ?? 0,
    surface: "chat",
    usageBasis: "provider-reported",
  })
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
  /** ADR-0090 execution identity, when the caller has it. */
  projectId?: string
  runId?: string
  turnId?: string
  attemptId?: string
  /** Pricing modifiers in effect for this turn. */
  speed?: "fast" | "normal"
  inferenceGeo?: "us" | "global"
  batch?: boolean
  /**
   * Router + Fusion (ADR-0188): the ledger's booking for this turn. The ledger
   * is the one writer of a ledgered turn's money, so its figure replaces the
   * SDK's. Absent for every other turn.
   */
  ledger?: { runId: string; costUsd: number }
}): Promise<SessionUsageRow | null> {
  const { sessionId, messageId, characterId, model, providerId, result, ledger } = args
  if (!sessionId || !messageId) return null
  // A ledgered turn keeps its booked spend even when the result carried no
  // usage (it ended on a refusal before the model answered).
  const usage = extractUsage(result) ?? (ledger ? {} : null)
  if (!usage) return null
  const costUsd = ledger ? Math.max(0, ledger.costUsd) : (usage.totalCostUsd ?? 0)
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
    costUsd,
    durationMs: usage.durationMs ?? 0,
    reasoningTokens:
      typeof usage.reasoningTokens === "number" && usage.reasoningTokens > 0
        ? usage.reasoningTokens
        : undefined,
    contextInputTokens:
      typeof usage.contextInputTokens === "number" && usage.contextInputTokens > 0
        ? usage.contextInputTokens
        : undefined,
    surface: "chat",
    // Frozen at write time. A positive figure came from the provider and is
    // authoritative; a zero one means this path reported no cost, and the
    // reader must price it rather than treating 0 as "free". Nothing here is
    // ever recomputed against a later price table. A ledger figure is known by
    // construction, including a booked zero (a subscription or free call).
    costSource: ledger ? "ledger" : costUsd > 0 ? "sdk" : "unknown",
    costKnown: ledger ? true : costUsd > 0,
    ...carryFrozenFields({
      cacheCreation5mTokens: usage.cacheCreation5mInputTokens,
      cacheCreation1hTokens: usage.cacheCreation1hInputTokens,
      unitBreakdown: usage.serverToolUse ? { requests: usage.serverToolUse } : undefined,
      projectId: args.projectId,
      runId: args.runId ?? ledger?.runId,
      turnId: args.turnId,
      attemptId: args.attemptId,
      speed: args.speed,
      inferenceGeo: args.inferenceGeo,
      batch: args.batch,
    }),
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
  durationMs?: number
  reasoningTokens?: number
  contextInputTokens?: number
  model?: string
  providerId?: string

  /* ── v172 frozen-cost + identity passthrough ───────────────────────────── */
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
  costSource?: UsageCostSource
  costKnown?: boolean
  priceSnapshot?: UsagePriceSnapshot
  speed?: "fast" | "normal"
  inferenceGeo?: "us" | "global"
  batch?: boolean
  unitBreakdown?: UsageUnitBreakdown
  projectId?: string
  runId?: string
  turnId?: string
  attemptId?: string
  /** Marks spend that was paid elsewhere and must not blend into local totals. */
  imported?: boolean

  /* ── v218 external usage index passthrough ─────────────────────────────── */
  sourceId?: string
  sourceSessionId?: string
  sourceRevision?: string
  usageBasis?: UsageBasis
  analysisVersion?: number
}

/**
 * Copy the frozen-cost and identity fields onto a row, omitting absent ones so
 * a legacy caller does not write a wall of `undefined` keys into Dexie.
 */
function carryFrozenFields(usage: SurfaceUsageInput): Partial<SessionUsageRow> {
  const out: Partial<SessionUsageRow> = {}
  if (usage.imported !== undefined) out.imported = usage.imported
  if (usage.costSource !== undefined) out.costSource = usage.costSource
  if (usage.costKnown !== undefined) out.costKnown = usage.costKnown
  if (usage.priceSnapshot !== undefined) out.priceSnapshot = usage.priceSnapshot
  if (usage.speed !== undefined) out.speed = usage.speed
  if (usage.inferenceGeo !== undefined) out.inferenceGeo = usage.inferenceGeo
  if (usage.batch !== undefined) out.batch = usage.batch
  if (usage.unitBreakdown !== undefined) out.unitBreakdown = usage.unitBreakdown
  if (usage.projectId !== undefined) out.projectId = usage.projectId
  if (usage.runId !== undefined) out.runId = usage.runId
  if (usage.turnId !== undefined) out.turnId = usage.turnId
  if (usage.attemptId !== undefined) out.attemptId = usage.attemptId
  if (usage.sourceId !== undefined) out.sourceId = usage.sourceId
  if (usage.sourceSessionId !== undefined) out.sourceSessionId = usage.sourceSessionId
  if (usage.sourceRevision !== undefined) out.sourceRevision = usage.sourceRevision
  if (usage.usageBasis !== undefined) out.usageBasis = usage.usageBasis
  if (usage.analysisVersion !== undefined) out.analysisVersion = usage.analysisVersion
  const c5 = num(usage.cacheCreation5mTokens)
  const c1h = num(usage.cacheCreation1hTokens)
  if (c5 > 0) out.cacheCreation5mTokens = c5
  if (c1h > 0) out.cacheCreation1hTokens = c1h
  return out
}

const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/**
 * A turn's {@link UsageInfo} in the shadow-row token shape, every tier kept:
 * the TTL-split cache writes and server-tool requests are billed separately,
 * so dropping them would under-price the row once it is frozen.
 *
 * A positive cost is the provider's and is kept. A zero is ambiguous: the
 * Claude Agent SDK computes cost itself, so its zero is a real figure
 * (`costAuthority`), while the AI-SDK result adapter emits zero when the
 * provider reported none, and that row is left for the ledger to price.
 */
export function surfaceUsageFromUsageInfo(
  usage: UsageInfo,
  opts: { costAuthority?: boolean } = {}
): SurfaceUsageInput {
  return {
    ...(opts.costAuthority && usage.totalCostUsd === 0
      ? { costSource: "sdk" as const, costKnown: true }
      : {}),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadInputTokens,
    cacheCreationTokens: usage.cacheCreationInputTokens,
    cacheCreation5mTokens: usage.cacheCreation5mInputTokens,
    cacheCreation1hTokens: usage.cacheCreation1hInputTokens,
    costUsd: usage.totalCostUsd,
    durationMs: usage.durationMs,
    reasoningTokens: usage.reasoningTokens,
    contextInputTokens: usage.contextInputTokens,
    ...(usage.serverToolUse ? { unitBreakdown: { requests: usage.serverToolUse } } : {}),
  }
}

/**
 * The same, for a turn an external agent ran. Cognia never prices an external
 * turn itself (its CLI may bill a subscription rather than the API), so only
 * the agent's own USD figure is a cost and an unreported one is frozen as
 * `unknown`, never a catalog guess: the posture of {@link recordExternalAgentUsage}.
 */
export function externalAgentSurfaceUsage(usage: UsageInfo): SurfaceUsageInput {
  const costKnown = usage.totalCostUsd !== undefined
  return {
    ...surfaceUsageFromUsageInfo(usage),
    costKnown,
    costSource: costKnown ? "sdk" : "unknown",
    usageBasis: "provider-reported",
  }
}

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
  const cacheCreationTokens = num(usage.cacheCreationTokens)
  const cacheReadTokens = num(usage.cacheReadTokens)
  const costUsd = num(usage.costUsd)
  // Stub / no-op steps (e.g. the ai.prompt echo) report nothing at all — don't
  // pollute the billing table with empty turns. A fully cache-served turn bills
  // real money while reporting `inputTokens === 0 && outputTokens === 0`, so the
  // emptiness test must consider the cache tiers and the cost as well; testing
  // only input/output silently dropped those rows, which also made this writer
  // disagree with `recordResultUsage` (the chat path applies no such filter).
  const splitCacheCreation = num(usage.cacheCreation5mTokens) + num(usage.cacheCreation1hTokens)
  const unitCount = Object.values(usage.unitBreakdown?.requests ?? {}).reduce(
    (n, v) => n + (typeof v === "number" && Number.isFinite(v) ? v : 0),
    num(usage.unitBreakdown?.pages) +
      num(usage.unitBreakdown?.characters) +
      num(usage.unitBreakdown?.containerHours)
  )
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheCreationTokens === 0 &&
    cacheReadTokens === 0 &&
    splitCacheCreation === 0 &&
    unitCount === 0 &&
    costUsd === 0
  ) {
    return null
  }
  return {
    messageId: args.messageId,
    sessionId: args.sessionId,
    at: args.at,
    model: usage.model,
    providerId: usage.providerId,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    costUsd,
    durationMs: num(usage.durationMs),
    reasoningTokens: num(usage.reasoningTokens) > 0 ? num(usage.reasoningTokens) : undefined,
    contextInputTokens:
      num(usage.contextInputTokens) > 0 ? num(usage.contextInputTokens) : undefined,
    surface: args.surface,
    ...carryFrozenFields(usage),
  }
}

/**
 * Shadow-write connector auto-mode usage. Idempotency is scoped to the
 * adapter/conversation/timestamp tuple because connector retries can produce
 * multiple distinct auto replies for the same platform thread.
 */
export async function recordConnectorUsage(args: {
  adapterId: string
  conversationKey: string
  usage: UsageInfo
  at?: number
}): Promise<SessionUsageRow | null> {
  if (!args.adapterId || !args.conversationKey) return null
  const at = args.at ?? Date.now()
  const row = buildSurfaceRow({
    messageId: `conn:${args.adapterId}:${args.conversationKey}:${at}`,
    sessionId: `conn:${args.adapterId}`,
    surface: "connector",
    usage: {
      inputTokens: args.usage.inputTokens,
      outputTokens: args.usage.outputTokens,
      cacheReadTokens: args.usage.cacheReadInputTokens,
      cacheCreationTokens: args.usage.cacheCreationInputTokens,
      costUsd: args.usage.totalCostUsd,
      durationMs: args.usage.durationMs,
      reasoningTokens: args.usage.reasoningTokens,
      contextInputTokens: args.usage.contextInputTokens,
    },
    at,
  })
  if (!row) return null
  await upsertSessionUsage(row)
  return row
}

/**
 * Shadow-write scheduled or renderer-driven goal turn usage. The turn driver
 * owns the monotonically increasing turn number, so callers pass the resolved
 * turn id after the goal row has accepted the turn.
 */
export async function recordGoalUsage(args: {
  goalId: string
  turnId: string | number
  usage: UsageInfo
  at?: number
}): Promise<SessionUsageRow | null> {
  if (!args.goalId || args.turnId === "") return null
  const turnId = String(args.turnId)
  const row = buildSurfaceRow({
    messageId: `goal:${args.goalId}:${turnId}`,
    sessionId: `goal:${args.goalId}`,
    surface: "goal",
    usage: {
      inputTokens: args.usage.inputTokens,
      outputTokens: args.usage.outputTokens,
      cacheReadTokens: args.usage.cacheReadInputTokens,
      cacheCreationTokens: args.usage.cacheCreationInputTokens,
      costUsd: args.usage.totalCostUsd,
      durationMs: args.usage.durationMs,
      reasoningTokens: args.usage.reasoningTokens,
      contextInputTokens: args.usage.contextInputTokens,
    },
    at: args.at ?? Date.now(),
  })
  if (!row) return null
  await upsertSessionUsage(row)
  return row
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

/**
 * Shadow-write usage for any of the non-conversational metered surfaces
 * (embeddings, twin distillation, memory, eval, subagents, plugins, OCR, TTS,
 * web search, imported transcripts).
 *
 * The caller owns idempotency by supplying a deterministic `operationId`; the
 * row key is `<surface>:<operationId>` so a retried operation overwrites its
 * earlier attempt exactly like the chat path overwrites on message id.
 * Grouping key is `<surface>:<scopeId>` — a project, a session, a job — so the
 * Usage tab can roll these up without inventing a fake chat session.
 */
export async function recordSurfaceUsage(args: {
  surface: UsageSurface
  /** Deterministic per-operation id. Retries MUST reuse it. */
  operationId: string
  /** Grouping key (project id, session id, job id). Defaults to the surface. */
  scopeId?: string
  /**
   * Exact grouping key, used verbatim instead of `<surface>:<scopeId>`. For
   * spend that belongs to an existing conversation or run (a best-of-N
   * candidate's child session, `bot:<runId>`), so it rolls up with that id
   * rather than under a synthetic one.
   */
  sessionId?: string
  usage: SurfaceUsageInput
  at?: number
}): Promise<SessionUsageRow | null> {
  if (!args.surface || !args.operationId) return null
  const row = buildSurfaceRow({
    messageId: `${args.surface}:${args.operationId}`,
    sessionId: args.sessionId || `${args.surface}:${args.scopeId ?? args.surface}`,
    surface: args.surface,
    usage: args.usage,
    at: args.at ?? Date.now(),
  })
  if (!row) return null
  await upsertSessionUsage(row)
  return row
}

/**
 * Record usage reconstructed from an imported transcript.
 *
 * Always written with `imported: true` and never with `surface` set to the
 * originating surface: this spend was paid on another machine and must be
 * separable from local spend at read time by a single predicate.
 */
export async function recordImportedUsage(args: {
  /** Deterministic id from the source transcript (message/entry id). */
  operationId: string
  sessionId: string
  usage: SurfaceUsageInput
  at?: number
}): Promise<SessionUsageRow | null> {
  if (!args.operationId || !args.sessionId) return null
  const row = buildSurfaceRow({
    messageId: `imported:${args.operationId}`,
    sessionId: args.sessionId,
    surface: "imported",
    usage: { ...args.usage, imported: true },
    at: args.at ?? Date.now(),
  })
  if (!row) return null
  await upsertSessionUsage(row)
  return row
}

/** True when the row records spend this install actually paid for. */
export function isLocalSpend(row: Pick<SessionUsageRow, "imported">): boolean {
  return row.imported !== true
}

/** Read all rows for one session, oldest-first (matches the message order). */
export async function listUsageForSession(sessionId: string): Promise<SessionUsageRow[]> {
  return getDb().sessionUsage.where("sessionId").equals(sessionId).sortBy("at")
}

/**
 * Rows a project (workspace) paid for locally since `since` (inclusive),
 * oldest-first. One `[projectId+at]` range scan; imported rows are dropped
 * because they were paid elsewhere and must not count against this install's
 * per-project budget (ADR-0204).
 */
export async function listLocalUsageForProjectSince(
  projectId: string,
  since: number
): Promise<SessionUsageRow[]> {
  const rows = await getDb()
    .sessionUsage.where("[projectId+at]")
    .between([projectId, since], [projectId, Number.MAX_SAFE_INTEGER], true, true)
    .toArray()
  return rows.filter(isLocalSpend)
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
export async function totalsByAllSessions(
  options: { includeImported?: boolean } = {}
): Promise<Map<string, SessionUsageTotals>> {
  const rows = await getDb().sessionUsage.toArray()
  const grouped = new Map<string, SessionUsageRow[]>()
  for (const r of rows) {
    // Imported spend was paid on another machine, often by another account.
    // Counting it here would inflate "what this install cost me".
    if (!options.includeImported && !isLocalSpend(r)) continue
    const list = grouped.get(r.sessionId)
    if (list) list.push(r)
    else grouped.set(r.sessionId, [r])
  }
  const out = new Map<string, SessionUsageTotals>()
  for (const [sid, list] of grouped) out.set(sid, aggregate(list))
  return out
}

/** Billable token volume for a session — the cost-independent ranking signal. */
function totalTokens(t: SessionUsageTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens
}

/**
 * Top N sessions by cumulative cost. Sessions with no recorded activity at all
 * are skipped; ties are broken by token volume, then turn count, then sessionId
 * so the order is deterministic in tests.
 *
 * Zero-cost sessions are deliberately NOT excluded: free and locally-hosted
 * models legitimately cost $0 while dominating token volume, and filtering on
 * `costUsd <= 0` made them invisible here. It also hid every row whose price
 * was merely unknown, which reads identically to $0 in storage.
 */
export async function topByCost(
  limit = 10
): Promise<Array<{ sessionId: string; totals: SessionUsageTotals }>> {
  const map = await totalsByAllSessions()
  const entries: Array<{ sessionId: string; totals: SessionUsageTotals }> = []
  for (const [sessionId, totals] of map) {
    if (totals.costUsd <= 0 && totalTokens(totals) === 0) continue
    entries.push({ sessionId, totals })
  }
  entries.sort((a, b) => {
    if (b.totals.costUsd !== a.totals.costUsd) return b.totals.costUsd - a.totals.costUsd
    const at = totalTokens(a.totals)
    const bt = totalTokens(b.totals)
    if (bt !== at) return bt - at
    if (b.totals.turns !== a.totals.turns) return b.totals.turns - a.totals.turns
    return a.sessionId.localeCompare(b.sessionId)
  })
  return entries.slice(0, Math.max(0, Math.floor(limit)))
}

/** Drop every row for a session — called when the session itself is deleted. */
export async function deleteUsageForSession(sessionId: string): Promise<void> {
  await getDb().sessionUsage.where("sessionId").equals(sessionId).delete()
}

/**
 * Drop usage rows older than the retention window. Defaults to 90 days so the
 * unified usage table does not grow without bound across chat, workflow,
 * connector, goal, and agent-team surfaces. `days <= 0` disables pruning.
 */
export async function pruneSessionUsageOlderThan(
  days = 90,
  now: number = Date.now()
): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) return 0
  const cutoff = now - days * 86_400_000
  const db = getDb()
  const stale = await db.sessionUsage.where("at").below(cutoff).primaryKeys()
  if (stale.length === 0) return 0
  await db.sessionUsage.bulkDelete(stale)
  return stale.length
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
