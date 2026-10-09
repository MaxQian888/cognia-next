// Rename a hatched pet. A thin, validated wrapper over `patchPetProfile` that
// touches only `soul.name` — the personality + hatch date stay immutable. A
// no-op (returns undefined) when there is no profile or no soul yet (the pet
// must hatch before it can be renamed).

import { hasNoLeakingPii } from "@cognia/redact"
import { getPetProfile, patchPetProfile } from "@/lib/db/pet"
import { MAX_NAME } from "@/lib/pet/soul/generate-soul"
import type { PetProfile } from "@/types/pet"

export const MAX_PET_NAME = MAX_NAME

/** Normalize a candidate name: collapse whitespace and clamp to the cap. */
export function sanitizePetName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_PET_NAME)
}

/**
 * True when `raw` is a usable pet name: non-empty after sanitizing, and free of
 * anything the PII gate would block. The name is spliced into every pet system
 * prompt (`lib/pet/llm/persona.ts`), proactive speech included, so an email or
 * phone number typed as a name would otherwise reach the model on every turn.
 */
export function isValidPetName(raw: string): boolean {
  const name = sanitizePetName(raw)
  return name.length > 0 && hasNoLeakingPii(name)
}

/**
 * Persist a new display name for the pet. Returns the updated profile, or
 * undefined when there is nothing to rename (no profile / no soul) or the name
 * is not valid ({@link isValidPetName}).
 */
export async function renamePet(raw: string, now = Date.now()): Promise<PetProfile | undefined> {
  if (!isValidPetName(raw)) return undefined
  const name = sanitizePetName(raw)
  const cur = await getPetProfile()
  if (!cur?.soul) return undefined
  if (cur.soul.name === name) return cur
  return patchPetProfile({ soul: { ...cur.soul, name } }, now)
}
