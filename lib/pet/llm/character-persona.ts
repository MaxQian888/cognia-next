// Resolves a bound Character's persona prose for the desktop pet's LLM voice.
//
// The pet channel only ever carried `PetSoul.personality`; a Character bound to
// the active session (and its optional Twin) models a far richer identity that
// previously never reached the pet. This composes ONE concise prose line from
// the Character's `persona` metadata and — when the Character is twin-bound —
// the already-distilled, PII-gated twin `voiceSummary`. It NEVER re-runs RAG: it
// only reads the stored summary. The line is capped so the pet's tiny token
// budget isn't blown, and the caller PII-gates the result before sending.

import type { Character } from "@cognia/agent-config-types"
import { resolveCharacterById } from "@/lib/db/characters"
import { getTwinProfile } from "@/lib/db/twin-profile"

/** Hard cap on the composed persona line — the pet prompt has a tiny budget. */
const MAX_PERSONA_LEN = 200

/**
 * Compose one concise persona line: personality first, then tone, then the
 * twin voice summary when present. Returns `""` when nothing usable exists.
 * Pure — the side-effect-free core of {@link resolveCharacterPersona}.
 */
export function composePersonaLine(
  persona: Character["persona"] | undefined,
  voiceSummary: string | undefined,
  maxLen: number = MAX_PERSONA_LEN
): string {
  const parts: string[] = []
  const personality = persona?.personality?.trim()
  const tone = persona?.tone?.trim()
  const voice = voiceSummary?.trim()
  if (personality) parts.push(personality)
  if (tone) parts.push(`tone: ${tone}`)
  if (voice) parts.push(voice)
  let line = parts.join("; ")
  if (line.length > maxLen) line = line.slice(0, maxLen).trimEnd()
  return line
}

export interface ResolveCharacterPersonaDeps {
  loadCharacter?: (id: string) => Promise<Character | undefined>
  loadTwinProfile?: (twinId: string) => Promise<{ voiceSummary?: string } | undefined>
}

/**
 * Resolve the bound Character's persona prose for the pet voice. Reads the
 * Character's `persona` metadata and, when the character is twin-bound, appends
 * the STORED twin `voiceSummary` (no RAG). Returns `null` when the character is
 * missing or has no usable persona. Deps are injectable for tests.
 */
export async function resolveCharacterPersona(
  characterId: string,
  deps: ResolveCharacterPersonaDeps = {}
): Promise<string | null> {
  const loadCharacter = deps.loadCharacter ?? resolveCharacterById
  const loadTwinProfile = deps.loadTwinProfile ?? getTwinProfile
  const character = await loadCharacter(characterId)
  if (!character) return null
  let voiceSummary: string | undefined
  if (character.twinId) {
    const profile = await loadTwinProfile(character.twinId)
    voiceSummary = profile?.voiceSummary
  }
  const line = composePersonaLine(character.persona, voiceSummary)
  return line || null
}
