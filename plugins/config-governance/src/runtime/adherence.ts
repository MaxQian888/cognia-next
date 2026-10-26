/**
 * The adherence pipeline (ADR-0238 §8): is each rule actually followed?
 *
 * Two steps the user runs separately, because they cost differently:
 * deriving checks is one model call over the rules (redacted, like every
 * text the model sees) and is redone only when the rules change; replaying
 * them over past sessions is local and free, and is what the drift check and
 * the before/after comparison re-run.
 */

import type { PluginAgentConfigAPI } from "@cognia/plugin-sdk"

import { runBacktest } from "../adherence/backtest"
import type { RuleCheck } from "../adherence/checks"
import { buildDeriveRequest, buildDeriveRules, parseDeriveAnswer } from "../adherence/derive"
import {
  extractSessionEvents,
  type SessionEvents,
  type StoredMessageLike,
} from "../adherence/events"
import type { LlmBridge } from "../engine/llm"
import { segmentRules } from "../engine/segment"
import { PROMPT_IDS } from "../prompts"
import type { StoredAdherence, StoredChecks } from "./store"

/** Surfaces whose rules apply to every turn, so their compliance shows in any session. */
const ALWAYS_LOADED = new Set([
  "instruction-file",
  "agent-file",
  "workspace-instructions",
  "app-setting",
])

/** Sessions replayed by default, most recent first. */
export const DEFAULT_SESSION_LIMIT = 50
/** Messages read per session; a longer session is replayed from its start up to this. */
export const MAX_MESSAGES_PER_SESSION = 2_000

export interface SessionSourceLike {
  listSessions(filter?: {
    projectId?: string
    limit?: number
    sortBy?: "createdAt" | "updatedAt" | "title"
    sortOrder?: "asc" | "desc"
  }): Promise<Array<{ id: string; projectId?: string; createdAt: number | Date }>>
  getMessages(sessionId: string, options?: { limit?: number }): Promise<unknown[]>
}

export interface DeriveDeps {
  agentConfig: PluginAgentConfigAPI
  llm: LlmBridge
  resolvePrompt(id: string): Promise<string>
  now(): number
  signal?: AbortSignal
}

export async function deriveChecks(
  deps: DeriveDeps,
  workspaceId: string | null
): Promise<StoredChecks> {
  const listing = await deps.agentConfig.listSurfaces({ workspaceId })
  const surfaces: Array<{
    surfaceKey: string
    surfaceName: string
    units: ReturnType<typeof segmentRules>
  }> = []
  for (const surface of listing.surfaces) {
    if (!ALWAYS_LOADED.has(surface.source) || surface.unavailable) continue
    const document = await deps.agentConfig.readSurface(surface.key, { workspaceId })
    if (!document?.text.trim()) continue
    const redacted = deps.agentConfig.redactForModel(document.text)
    if (redacted === null) continue
    surfaces.push({
      surfaceKey: surface.key,
      surfaceName: surface.name,
      units: segmentRules(redacted),
    })
  }
  const rules = buildDeriveRules(surfaces)
  if (rules.length === 0) return { derivedAt: deps.now(), checks: [], notCheckable: 0, rejected: 0 }
  const answer = await deps.llm.complete(
    [
      { role: "system", content: await deps.resolvePrompt(PROMPT_IDS.derive) },
      { role: "user", content: buildDeriveRequest(rules) },
    ],
    deps.signal ? { signal: deps.signal } : {}
  )
  const result = parseDeriveAnswer(answer, rules)
  return {
    derivedAt: deps.now(),
    checks: result.checks,
    notCheckable: result.notCheckable.length,
    rejected: result.rejected.length,
  }
}

function toMillis(value: number | Date): number {
  return value instanceof Date ? value.getTime() : value
}

export interface CollectOptions {
  workspaceId: string | null
  limit?: number
  /** Only sessions created at or after this time. */
  since?: number
  /** Only sessions created before this time. */
  until?: number
  signal?: AbortSignal
}

export async function collectSessions(
  source: SessionSourceLike,
  options: CollectOptions
): Promise<SessionEvents[]> {
  const limit = options.limit ?? DEFAULT_SESSION_LIMIT
  const listed = await source.listSessions({
    ...(options.workspaceId ? { projectId: options.workspaceId } : {}),
    // Over-fetch: the time window is applied here, not by the host.
    limit: limit * 3,
    sortBy: "createdAt",
    sortOrder: "desc",
  })
  const sessions = listed
    .filter((session) => (options.workspaceId ? session.projectId === options.workspaceId : true))
    .filter(
      (session) => options.since === undefined || toMillis(session.createdAt) >= options.since
    )
    .filter((session) => options.until === undefined || toMillis(session.createdAt) < options.until)
    .slice(0, limit)
  const out: SessionEvents[] = []
  for (const session of sessions) {
    if (options.signal?.aborted) break
    const messages = (await source.getMessages(session.id, {
      limit: MAX_MESSAGES_PER_SESSION,
    })) as StoredMessageLike[]
    const events = extractSessionEvents(session.id, messages)
    if (events.events.length > 0) out.push(events)
  }
  return out
}

export interface BacktestRunOptions extends CollectOptions {
  checks: readonly RuleCheck[]
  falseMatches: ReadonlySet<string>
  roots: readonly string[]
  now(): number
}

export async function runAdherence(
  source: SessionSourceLike,
  options: BacktestRunOptions
): Promise<StoredAdherence> {
  const sessions = await collectSessions(source, options)
  const results = runBacktest({
    checks: options.checks,
    sessions,
    falseMatches: options.falseMatches,
    roots: options.roots,
  })
  return {
    ranAt: options.now(),
    sessions: sessions.length,
    results,
    ...(options.since !== undefined ? { since: options.since } : {}),
    ...(options.until !== undefined ? { until: options.until } : {}),
  }
}
