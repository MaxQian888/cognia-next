/**
 * Plugin Pet Contribution Types
 *
 * Declarative, DATA-ONLY manifest blocks for the two pet overlay registries
 * (`petAchievements` / `petItems`). Manifests round-trip through the Dexie
 * plugin store, so — unlike the host's `PET_ACHIEVEMENTS` whose `isUnlocked`
 * is a function — plugin achievements declare a small condition DSL that the
 * host compiles into a predicate at register time
 * (`lib/plugin/registries/pet-achievement-registry.ts`).
 */

/** Declarative unlock condition, interpreted by the host. */
export type PluginPetAchievementCondition =
  /** Activity-ledger counter: `counters[kind] >= gte` (kind = PetEventKind). */
  | { type: "counter"; kind: string; gte: number }
  /** Pet level milestone: `profile.level >= gte`. */
  | { type: "level"; gte: number }
  /** Live need threshold: `needs[need] >= gte` (energy | mood | bond). */
  | { type: "need"; need: "energy" | "mood" | "bond"; gte: number }

export interface PluginPetAchievementDef {
  /** Pack-local id; the host namespaces it as `plugin:<pluginId>:<id>`. */
  id: string
  /**
   * Display labels keyed by locale ("en" required, others optional). Plain
   * strings, not i18n keys — pack-def precedent (picker-facing names).
   */
  labels: Record<string, string>
  /** Optional per-locale descriptions (same keying as `labels`). */
  descriptions?: Record<string, string>
  /** Lucide icon name; the achievements tab falls back to Sparkles. */
  icon?: string
  condition: PluginPetAchievementCondition
}

export interface PluginPetItemDef {
  /** Pack-local id; the host namespaces it as `plugin:<pluginId>:<id>`. */
  id: string
  /** Display labels keyed by locale ("en" required). Plain strings. */
  labels: Record<string, string>
  /** Optional per-locale descriptions. */
  descriptions?: Record<string, string>
  /** Lucide icon name; the shop falls back to Sparkles. */
  icon?: string
  /** Shop grouping — mirrors the host catalog categories. */
  category: "food" | "toy" | "decor"
  /** Price in coins (> 0). */
  price: number
  /** True for consumables (quantity decremented on use). */
  consumable: boolean
  /** Event kind emitted when a consumable is used (interaction kinds only). */
  interactionKind?: "fed" | "played" | "petted" | "talked" | "slept" | "cleaned" | "treated"
  /** Differentiated needs restore; overrides the interaction's base effect. */
  needsEffect?: Partial<Record<"energy" | "mood" | "bond", number>>
}
