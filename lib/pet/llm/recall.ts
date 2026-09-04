// Read-only recall bridge into the autonomous memory subsystem. The pet may
// KNOW what the user has shared (top-K semantic/episodic facts) but never
// writes back, because pet conversations are not extraction-worthy by design.
// Any failure degrades to "" (no recall layer), never an error.
//
// Every recalled line passes the PII gate before it can reach a prompt. The
// callers already gate the user's own text and the persona, but this layer was
// unchecked, and it is the one that deliberately asks for `personal-only`
// claims: facts the user shared about themselves. A line that trips the gate is
// dropped on its own rather than degrading the whole recall, so the pet keeps
// whatever context was safe to keep.

import { retrieveMemories, type MemoryRetrieverDeps } from "@/lib/memory/retrieve/retriever"
import { hasNoLeakingPii } from "@cognia/redact"

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
        // This function's whole contract is "what the user has shared" — its
        // output is rendered into the pet's prompt as things it knows ABOUT the
        // user. Mined project claims are facts about a repository, and would
        // read there as if the user had told the pet about their build system.
        claimFilter: "personal-only",
        recencyHalfLifeDays: input.recencyHalfLifeDays,
      },
      deps
    )
    return recalled
      .map((r) => r.memory.text)
      .filter((text) => hasNoLeakingPii(text))
      .map((text) => `- ${text}`)
      .join("\n")
  } catch {
    return ""
  }
}
