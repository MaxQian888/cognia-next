// Profile lifecycle: ensure the singleton exists, and hatch the egg (generate +
// persist the Soul) on demand. Both are idempotent. The account id is resolved
// by the caller (`lib/pet/bones/account-id.ts`) so this stays storage-only.

import type { LlmClient } from "@/lib/twin/distill/llm"
import type { PetProfile } from "@/types/pet"
import { getPetProfile, upsertPetProfile } from "@/lib/db/pet"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { generateBones } from "@/lib/pet/bones/generate"
import { generatePetSoul } from "@/lib/pet/soul/generate-soul"
import { stageForLevel } from "@/lib/pet/xp/leveling"
import { enqueuePetWork } from "@/lib/pet/runtime/pet-controller"

/** Ensure a profile row exists for this account; create a fresh egg if not. */
export async function ensurePetProfile(accountId: string, now = Date.now()): Promise<PetProfile> {
  const existing = await getPetProfile()
  if (existing) return existing
  return upsertPetProfile(createDefaultProfile(accountId, now))
}

/**
 * Hatch the egg: generate the Soul (LLM, with deterministic fallback) and move to
 * the level-appropriate stage. No-op if already hatched or no profile exists.
 *
 * The model call runs outside the controller's serialization chain (it can take
 * seconds and would stall every interaction behind it), but the write does not:
 * it re-reads the row inside `enqueuePetWork` and patches only the Soul and the
 * stage. Writing the profile read before generation would silently drop any XP
 * or coins the controller awarded while the model was still answering.
 */
export async function hatchPet(
  client: LlmClient | null,
  now = Date.now()
): Promise<PetProfile | undefined> {
  const profile = await getPetProfile()
  if (!profile || profile.soul) return profile
  const bones = generateBones(profile.accountFingerprint)
  const soul = await generatePetSoul(client, bones, { now })
  return enqueuePetWork(async () => {
    const latest = await getPetProfile()
    // Reset or hatched by another path while the model was answering: the
    // freshly generated Soul belongs to a profile that no longer needs it.
    if (!latest || latest.soul) return latest
    return upsertPetProfile({
      ...latest,
      soul,
      stage: stageForLevel(latest.level),
      updatedAt: new Date(now).toISOString(),
    })
  })
}
