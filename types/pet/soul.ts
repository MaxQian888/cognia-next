// The "Soul" — the parts of the pet's identity that are generated once (by the
// utility LLM at hatch) and then persisted. Unlike Bones, the Soul is stored on
// the PetProfile and survives restarts. See `lib/pet/soul/generate-soul.ts`.

export interface PetSoul {
  /** LLM-generated display name (e.g. "Boba"). */
  name: string
  /**
   * LLM-generated personality fragment, injected into `@name` replies. Plain
   * prose, no PII (generated from species/rarity only).
   */
  personality: string
  /** ISO 8601 timestamp of when the egg hatched. */
  hatchDate: string
}
