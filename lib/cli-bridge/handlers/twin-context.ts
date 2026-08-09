/**
 * Renderer handler for the CLI bridge's `twin_context_get` command
 * (`POST /api/dev/twin/context`).
 *
 * The CLI is a separate Node process with its own fake-indexeddb — it can
 * never reach the GUI's Dexie tables or the native vector store, so twin
 * retrieval MUST run here in the renderer. Returns only what the CLI needs
 * to assemble its prompt:
 *
 *   - the applied twin system prompt (full + stable/dynamic cache segments),
 *     which is built from `chunk.contentRedacted` — already PII-safe;
 *   - source titles + scores for display. NEVER the retrieved chunks' raw
 *     `content` (that field is unredacted by design and must not cross the
 *     bridge boundary).
 *
 * Never throws — every failure shape resolves to `{ ok: false, error }` or
 * an honest degraded result, matching the twin runtime's own semantics.
 */

export interface TwinContextRequest {
  characterId?: string
  /** The user message the twin context should be retrieved for. */
  message?: string
  sessionId?: string
}

export interface TwinContextResult {
  ok: boolean
  /** Absent when the character is not twin-bound (nothing to apply). */
  applied?: {
    systemPrompt: string
    stable?: string
    dynamic?: string
  }
  degraded: boolean
  degradedReason?: string
  /** Source titles + scores only — no chunk content. */
  sources: Array<{ title?: string; score: number }>
  styleSampleCount: number
  error?: string
}

const EMPTY: Omit<TwinContextResult, "ok"> = {
  degraded: false,
  sources: [],
  styleSampleCount: 0,
}

export async function twinContextGet(payload: Record<string, unknown>): Promise<TwinContextResult> {
  const req = payload as TwinContextRequest
  const message = typeof req.message === "string" ? req.message.trim() : ""
  if (!message) {
    return { ok: false, ...EMPTY, error: "twin_context_get requires a non-empty message" }
  }
  const characterId = typeof req.characterId === "string" ? req.characterId : ""
  if (!characterId) {
    return { ok: false, ...EMPTY, error: "twin_context_get requires a characterId" }
  }

  try {
    const { getCharacter } = await import("@/lib/db/characters")
    const character = await getCharacter(characterId)
    if (!character) {
      return { ok: false, ...EMPTY, error: `character ${characterId} not found` }
    }
    if (!character.twinId) {
      // Not twin-bound — nothing to apply; the CLI skips twin injection.
      return { ok: true, ...EMPTY }
    }

    const { tryBuildTwinDeps } = await import("@/lib/twin/runtime/build-deps")
    const deps = await tryBuildTwinDeps()
    if (!deps) {
      return {
        ok: true,
        ...EMPTY,
        degraded: true,
        degradedReason: "twin runtime not configured (worker disabled or incomplete settings)",
      }
    }

    const { applyTwinContext } = await import("@/lib/twin/runtime")
    const result = await applyTwinContext({
      character,
      userMessage: message,
      ...(typeof req.sessionId === "string" && req.sessionId ? { sessionId: req.sessionId } : {}),
      deps: deps as Parameters<typeof applyTwinContext>[0]["deps"],
    })

    return {
      ok: true,
      ...(result.applied
        ? {
            applied: {
              systemPrompt: result.applied.systemPrompt,
              ...(result.applied.cacheSegments?.stable
                ? { stable: result.applied.cacheSegments.stable }
                : {}),
              ...(result.applied.cacheSegments?.dynamic
                ? { dynamic: result.applied.cacheSegments.dynamic }
                : {}),
            },
          }
        : {}),
      degraded: result.degraded,
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
      // Titles + scores only — retrievedChunks[].chunk.content is RAW
      // (unredacted) and must never cross the bridge.
      sources: result.retrievedChunks.map((c) => ({
        ...(c.sourceTitle ? { title: c.sourceTitle } : {}),
        score: c.score,
      })),
      styleSampleCount: result.selectedStyleSamples.length,
    }
  } catch (err) {
    return { ok: false, ...EMPTY, error: err instanceof Error ? err.message : String(err) }
  }
}
