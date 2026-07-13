// Read-only recall bridge into the autonomous memory subsystem. The pet may
// KNOW what the user has shared (top-K semantic/episodic facts) but never
// writes back — pet conversations are not extraction-worthy by design. Any
// failure degrades to "" (no recall layer), never an error.

import { retrieveMemories, type MemoryRetrieverDeps } from "@/lib/memory/retrieve/retriever"

export interface RecallAboutUserInput {
  queryText: string
  characterId?: string
  topK?: number
  relevanceFloor?: number
  /** Base recency half-life (days) from `MemoryConfig.decayHalfLifeDays`. */
  recencyHalfLifeDays?: number
}

/** Top-K recalled facts as "- fact" lines, or "" when nothing relevant. */
export async function recallAboutUser(
  deps: MemoryRetrieverDeps | undefined,
  input: RecallAboutUserInput
): Promise<string> {
  if (!deps) return ""
  const query = input.queryText.trim()
  if (!query) return ""
  try {
    const recalled = await retrieveMemories(
      {
        queryText: query,
        characterId: input.characterId,
        topK: input.topK ?? 3,
        relevanceFloor: input.relevanceFloor ?? 0.2,
        types: ["semantic", "episodic"],
        recencyHalfLifeDays: input.recencyHalfLifeDays,
      },
      deps
    )
    return recalled.map((r) => `- ${r.memory.text}`).join("\n")
  } catch {
    return ""
  }
}
