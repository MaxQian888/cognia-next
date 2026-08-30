// Deliberate ("explicit") long-term memory capture, shared by the `/remember`
// slash command and the composer's `#` prefix.
//
// This used to be a SECOND write funnel: it called the consolidator directly,
// so it skipped the agent policy gate, wrote no evidence and no audit row, and
// (the reason it was rewritten) never passed a `projectId`. A `workspace`
// capture therefore produced a row `isVisibleToReader` can never return, while
// the UI reported success.
//
// It is now a thin adapter over `storeMemoryCore`, whose only remaining job is
// to (a) pick the target namespace via the shared resolver and (b) translate
// the core's result union into the typed reasons its two callers already
// render. It respects `memory.enabled` and temporary mode but NOT `autoExtract`
// -- this is a deliberate user action.

import { getSettings } from "@/lib/db/settings"
import { getSession } from "@/lib/db/sessions"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { resolvePersistedAgentMemoryPolicy } from "@/lib/memory/agent-policy"
import { resolveMemoryAgentNamespace } from "@/lib/memory/twin-namespace"
import {
  auditMemoryScopeRefusal,
  resolveMemoryWriteTarget,
} from "@/lib/memory/scope/resolve-write-target"
import { storeMemoryCore } from "@/lib/memory/api/store-memory"
import type { MemoryScope } from "@/types/memory/memory"

/** Importance assigned to a deliberately captured fact (0-10 scale). */
export const EXPLICIT_MEMORY_IMPORTANCE = 7

export interface RememberFactInput {
  /** The fact to store, already trimmed by the caller. */
  text: string
  /**
   * Scope override. Omitted, the configured `scopeDefault` is used, which is
   * what `/remember` does. The `#` picker passes an explicit scope, and an
   * explicit scope is never widened: if policy refuses it, so do we.
   */
  scope?: MemoryScope
  /** Session the capture came from, for provenance and namespace resolution. */
  sessionId?: string | null
}

export type RememberFactResult =
  | { ok: true; scope: MemoryScope }
  | {
      ok: false
      reason:
        | "empty"
        | "disabled"
        | "temporary"
        | "pii"
        /** Agent policy or scope policy refused the write. */
        | "denied"
        /**
         * Legacy. It used to mean "no utility LLM client", but `storeMemoryCore`
         * degrades to a direct insert instead of dropping the fact, so nothing
         * produces it any more. Kept so the two callers and their translations
         * do not have to churn.
         */
        | "unavailable"
        | "failed"
    }

/**
 * Store one deliberately captured fact in long-term memory.
 *
 * Never throws: every failure mode is returned as a typed `reason` so the two
 * callers can render it their own way (`/remember` as a system card, `#` as a
 * toast).
 */
export async function rememberFact(input: RememberFactInput): Promise<RememberFactResult> {
  const text = input.text.trim()
  // Short-circuited here rather than in the core, which THROWS on empty text.
  if (!text) return { ok: false, reason: "empty" }

  const sessionId = input.sessionId ?? undefined

  try {
    const settings = await getSettings().catch(() => undefined)
    const config = resolveMemoryConfig(settings?.memory)
    if (!config.enabled) return { ok: false, reason: "disabled" }
    if (config.temporary) return { ok: false, reason: "temporary" }

    const session = sessionId ? await getSession(sessionId).catch(() => undefined) : undefined
    const policy = await resolvePersistedAgentMemoryPolicy({
      config,
      characterId: session?.characterId,
      sessionId,
    })

    const target = await resolveMemoryWriteTarget({
      requested: input.scope,
      configured: config.scopeDefault,
      policy,
      session: session ?? null,
      agentId: await resolveCaptureAgentId(session?.characterId),
    })
    if (!target.ok) {
      await auditMemoryScopeRefusal({
        sessionId,
        attempted: target.attempted,
        surface: "remember",
      })
      return { ok: false, reason: "denied" }
    }

    const result = await storeMemoryCore({
      text,
      scope: target.scope,
      ...(target.projectId ? { projectId: target.projectId } : {}),
      ...(target.characterId ? { characterId: target.characterId } : {}),
      ...(target.agentId ? { agentId: target.agentId } : {}),
      scopeRationale: target.scopeRationale,
      type: "semantic",
      importance: EXPLICIT_MEMORY_IMPORTANCE,
      provenance: "explicit",
      piiGate: "block",
      ...(sessionId ? { source: { sessionId } } : {}),
      ...(session?.characterId ? { policyCharacterId: session.characterId } : {}),
    })

    // A NOOP still counts as success: the consolidator judged the fact already
    // captured, which is what the user asked for.
    if (result.ok) return { ok: true, scope: target.scope }
    switch (result.reason) {
      case "disabled":
        return { ok: false, reason: "disabled" }
      case "temporary":
        return { ok: false, reason: "temporary" }
      case "pii_blocked":
        return { ok: false, reason: "pii" }
      default:
        return { ok: false, reason: "denied" }
    }
  } catch {
    return { ok: false, reason: "failed" }
  }
}

/**
 * The agent namespace a capture would land in, resolved the same way the turn
 * path resolves it. Only consulted when `scopeDefault` is `agent`, so the
 * character lookup is skipped for everyone else.
 */
async function resolveCaptureAgentId(characterId?: string): Promise<string | undefined> {
  if (!characterId) return undefined
  const { resolveCharacterById } = await import("@/lib/db/characters")
  const character = await resolveCharacterById(characterId).catch(() => undefined)
  return resolveMemoryAgentNamespace({ twinId: character?.twinId, characterId })
}
