/**
 * Plugin SDK helper for the `character-pack` capability (ADR-0030).
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineCharacterPack()` gives plugin authors autocomplete and a
 * compile-time check that the def shape matches `PluginCharacterPackDef`.
 *
 * Mirrors `lib/plugin/sdk/define-skill.ts` exactly so the helper
 * convention stays uniform across capabilities.
 *
 * Usage:
 *   const workplace = defineCharacterPack({
 *     id: "workplace",
 *     name: "Workplace Suite",
 *     version: "1.0.0",
 *     characters: [
 *       {
 *         localId: "alice",
 *         name: "Alice the Analyst",
 *         avatarColor: "oklch(0.7 0.15 250)",
 *         systemPrompt: "...",
 *       },
 *     ],
 *   })
 */

import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"

/**
 * Soft upper bound on characters per pack — keeps the in-memory overlay
 * cost predictable. See ADR-0030 §Risks: 50 × 10 KB systemPrompt = 500 KB
 * per plugin, which is acceptable but should not creep upward silently.
 */
export const PLUGIN_CHARACTER_PACK_SOFT_LIMIT = 50

export function defineCharacterPack(def: PluginCharacterPackDef): PluginCharacterPackDef {
  if (!def.characters || def.characters.length === 0) {
    throw new Error(`defineCharacterPack: pack "${def.id}" must declare at least one character`)
  }
  if (def.characters.length > PLUGIN_CHARACTER_PACK_SOFT_LIMIT) {
    throw new Error(
      `defineCharacterPack: pack "${def.id}" declares ${def.characters.length} characters; ` +
        `the soft limit is ${PLUGIN_CHARACTER_PACK_SOFT_LIMIT}. Split into multiple packs.`
    )
  }
  const seen = new Set<string>()
  for (const ch of def.characters) {
    if (seen.has(ch.localId)) {
      throw new Error(`defineCharacterPack: pack "${def.id}" has duplicate localId "${ch.localId}"`)
    }
    seen.add(ch.localId)
  }
  return def
}
