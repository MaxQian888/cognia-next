// Deliberate ("explicit") long-term memory capture — the single write path
// shared by the `/remember` slash command and the composer's `#` prefix.
//
// Explicit capture bypasses the salience gate and the extraction LLM (the text
// IS the memory) but still flows through the SAME consolidator as auto-extracted
// memories, so it dedupes / updates / supersedes instead of blindly piling up.
// Provenance is `explicit` (trusted, so it may become a procedural rule). It
// respects `memory.enabled` + temporary mode but NOT `autoExtract` — this is a
// deliberate user action.
//
// The PII gate (`hasNoLeakingPii`) is mandatory and lives here so neither caller
// can forget it; see the "Cross-cutting hooks" section of CLAUDE.md.

import { useSettingsStore } from "@/stores/settings"
import { getSession } from "@/lib/db/sessions"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { hasNoLeakingPii } from "@cognia/redact"
import type { MemoryScope } from "@/types/memory/memory"

/** Importance assigned to a deliberately captured fact (0-10 scale). */
export const EXPLICIT_MEMORY_IMPORTANCE = 7

export interface RememberFactInput {
  /** The fact to store, already trimmed by the caller. */
  text: string
  /**
   * Scope override. Omitted, the configured `scopeDefault` is used — which is
   * what `/remember` does. The `#` picker passes an explicit scope.
   */
  scope?: MemoryScope
  /** Session the capture came from, for provenance. */
  sessionId?: string | null
}

export type RememberFactResult =
  | { ok: true; scope: MemoryScope }
  | {
      ok: false
      reason: "empty" | "disabled" | "temporary" | "pii" | "unavailable" | "failed"
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
  if (!text) return { ok: false, reason: "empty" }

  const settings = useSettingsStore.getState().settings
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { ok: false, reason: "disabled" }
  if (config.temporary) return { ok: false, reason: "temporary" }
  if (!hasNoLeakingPii(text)) return { ok: false, reason: "pii" }

  const scope = input.scope ?? config.scopeDefault

  try {
    const sessionRow = input.sessionId
      ? await getSession(input.sessionId).catch(() => undefined)
      : undefined

    const { buildAutoExtractionDeps } = await import("@/lib/memory/write/run-memory-extraction")
    const deps = await buildAutoExtractionDeps(
      { session: sessionRow ?? null, appSettings: settings },
      config
    )
    if (!deps) return { ok: false, reason: "unavailable" }

    await deps.consolidate({
      candidates: [{ type: "semantic", text, importance: EXPLICIT_MEMORY_IMPORTANCE }],
      scope,
      // `characterId` only narrows a character-scoped memory; other scopes
      // ignore it, so it is passed only when the scope actually uses it.
      characterId: scope === "character" ? sessionRow?.characterId : undefined,
      provenance: "explicit",
      source: { sessionId: input.sessionId ?? undefined },
    })
    return { ok: true, scope }
  } catch {
    return { ok: false, reason: "failed" }
  }
}
