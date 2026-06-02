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

/** Ensure a profile row exists for this account; create a fresh egg if not. */
export async function ensurePetProfile(accountId: string, now = Date.now()): Promise<PetProfile> {
  const existing = await getPetProfile()
  if (existing) return existing
  return upsertPetProfile(createDefaultProfile(accountId, now))
}

/**
 * Hatch the egg: generate the Soul (LLM, with deterministic fallback) and move to
 * the level-appropriate stage. No-op if already hatched or no profile exists.
 */
export async function hatchPet(
  client: LlmClient | null,
  now = Date.now()
): Promise<PetProfile | undefined> {
  const profile = await getPetProfile()
  if (!profile || profile.soul) return profile
  const bones = generateBones(profile.accountFingerprint)
  const soul = await generatePetSoul(client, bones, { now })
  return upsertPetProfile({
    ...profile,
    soul,
    stage: stageForLevel(profile.level),
    updatedAt: new Date(now).toISOString(),
  })
}
