/**
 * Shared twin-injection helper for workflow + connector outbound paths (M6).
 *
 * Given a `characterId` and the user's prompt, this helper:
 *
 *   1. Looks up the character — if it has no `twinId`, returns the
 *      original system prompt unchanged.
 *   2. Calls `tryBuildTwinDeps()` — if the runtime isn't configured
 *      (no embedding key, no vector store), returns the original.
 *   3. Embeds the prompt + runs RAG + assembles the 4-segment system
 *      prompt via `applyTwinContext`.
 *   4. Records the call in the M6 inject-log ring buffer for the
 *      Settings UI to surface.
 *
 * Never throws — twin failures degrade silently to the original prompt
 * so chat / workflow runs keep working when the twin runtime is down.
 */

import { getCharacter } from "@/lib/db/characters"
import { recordTwinInject } from "@/lib/twin/runtime/inject-log"

export interface TwinInjectionInput {
  characterId?: string
  userPrompt: string
  /** Existing system prompt to wrap. Defaults to "". */
  baseSystemPrompt?: string
  /** Tag for the inject-log: "workflow:ai.prompt" / "connector:telegram" / …. */
  source: string
}

export interface TwinInjectionResult {
  /** The system prompt to send (modified or unchanged). */
  systemPrompt: string
  /** True when the helper actually swapped in twin context. */
  applied: boolean
  /** Set when the runtime degraded (logged in the ring buffer too). */
  degradedReason?: string
}

export async function injectTwinContext(input: TwinInjectionInput): Promise<TwinInjectionResult> {
  const base = input.baseSystemPrompt ?? ""
  if (!input.characterId) return { systemPrompt: base, applied: false }
  if (!input.userPrompt.trim()) return { systemPrompt: base, applied: false }
  try {
    const character = await getCharacter(input.characterId)
    if (!character?.twinId) return { systemPrompt: base, applied: false }
    const [{ tryBuildTwinDeps }, { applyTwinContext }] = await Promise.all([
      import("@/lib/twin/runtime/build-deps"),
      import("@/lib/twin/runtime/apply-twin-context"),
    ])
    const deps = await tryBuildTwinDeps()
    if (!deps) {
      recordTwinInject({
        ts: Date.now(),
        twinId: character.twinId,
        source: input.source,
        applied: false,
        degraded: true,
        degradedReason: "twin-deps-unavailable",
        chunkCount: 0,
        styleSampleCount: 0,
        tokensApprox: 0,
      })
      return {
        systemPrompt: base,
        applied: false,
        degradedReason: "twin-deps-unavailable",
      }
    }
    const result = await applyTwinContext({
      character,
      userMessage: input.userPrompt,
      // `tryBuildTwinDeps` returns the "structural mirror" of the deps shape
      // declared in build-options.ts; at runtime the store is the full
      // IVectorStore, so widening the type at this boundary is safe.
      deps: deps as unknown as Parameters<typeof applyTwinContext>[0]["deps"],
    })
    if (!result.applied) {
      recordTwinInject({
        ts: Date.now(),
        twinId: character.twinId,
        source: input.source,
        applied: false,
        degraded: result.degraded ?? false,
        degradedReason: result.degradedReason ?? null,
        chunkCount: 0,
        styleSampleCount: 0,
        tokensApprox: 0,
      })
      return {
        systemPrompt: base,
        applied: false,
        degradedReason: result.degradedReason,
      }
    }
    const systemPrompt = result.applied.systemPrompt
    recordTwinInject({
      ts: Date.now(),
      twinId: character.twinId,
      source: input.source,
      applied: true,
      degraded: result.degraded ?? false,
      degradedReason: result.degradedReason ?? null,
      chunkCount: result.applied.metadata.retrievedChunkIds.length,
      styleSampleCount: result.applied.metadata.styleSampleIds.length,
      tokensApprox: Math.ceil(systemPrompt.length / 4),
    })
    return { systemPrompt, applied: true }
  } catch (err) {
    // Never throw — twin failures degrade to the original prompt.
    return {
      systemPrompt: base,
      applied: false,
      degradedReason: err instanceof Error ? err.message : String(err),
    }
  }
}
