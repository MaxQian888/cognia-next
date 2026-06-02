// Soul generation: the pet's name + personality, produced once at hatch by the
// utility LLM and then persisted. The prompt uses ONLY species/rarity (no user
// data), so it is safe to send without a PII gate. On any failure we fall back to
// a deterministic name/personality so the pet always hatches with an identity.

import type { LlmClient } from "@/lib/twin/distill/llm"
import type { PetBones, PetSoul } from "@/types/pet"
import { seededRng, pick } from "@/lib/pet/bones/prng"

const FALLBACK_NAMES = [
  "Boba",
  "Mochi",
  "Pixel",
  "Nova",
  "Sprout",
  "Waffle",
  "Ziggy",
  "Pip",
  "Tofu",
  "Cosmo",
  "Bean",
  "Loki",
  "Suki",
  "Yuki",
  "Mango",
  "Biscuit",
  "Olive",
  "Pesto",
  "Cookie",
  "Nimbus",
]

const MAX_NAME = 24
const MAX_PERSONALITY = 240

function buildPrompt(bones: PetBones): string {
  return (
    `Name and characterize a tiny virtual desktop pet. ` +
    `It is a ${bones.rarity} ${bones.species}. ` +
    `Return ONLY minified JSON of the form {"name": string, "personality": string}. ` +
    `name: 1–2 words, cute, no quotes. ` +
    `personality: one short whimsical sentence describing the pet's vibe in third person. ` +
    `Do not reference the user or any personal data.`
  )
}

/** Extract and validate a {name, personality} object from a raw model reply. */
export function parseSoulResponse(raw: string): { name: string; personality: string } | null {
  if (!raw) return null
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  const name = typeof obj.name === "string" ? obj.name.trim().slice(0, MAX_NAME) : ""
  const personality =
    typeof obj.personality === "string" ? obj.personality.trim().slice(0, MAX_PERSONALITY) : ""
  if (!name || !personality) return null
  return { name, personality }
}

/** Deterministic identity used when the LLM is unavailable or returns junk. */
export function fallbackSoul(bones: PetBones, now: number): PetSoul {
  const rng = seededRng("pet-soul", `${bones.species}:${bones.rarity}:${bones.stats.snark}`)
  return {
    name: pick(rng, FALLBACK_NAMES),
    personality: `A ${bones.rarity} little ${bones.species} with a mind of its own.`,
    hatchDate: new Date(now).toISOString(),
  }
}

export interface GenerateSoulOptions {
  now?: number
}

/**
 * Hatch the pet's soul. Tries the LLM once; on null client, error, or unparseable
 * output, returns the deterministic fallback. Never throws.
 */
export async function generatePetSoul(
  client: LlmClient | null,
  bones: PetBones,
  options: GenerateSoulOptions = {}
): Promise<PetSoul> {
  const now = options.now ?? Date.now()
  if (!client) return fallbackSoul(bones, now)
  try {
    const text = await client.complete(buildPrompt(bones), {
      system: "You are a playful pet-naming assistant. Output only JSON.",
      temperature: 0.9,
      maxTokens: 80,
    })
    const parsed = parseSoulResponse(text)
    if (!parsed) return fallbackSoul(bones, now)
    return { ...parsed, hatchDate: new Date(now).toISOString() }
  } catch {
    return fallbackSoul(bones, now)
  }
}
