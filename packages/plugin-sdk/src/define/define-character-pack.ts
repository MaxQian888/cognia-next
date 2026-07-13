/**
 * Plugin SDK helper for the `character-pack` capability (ADR-0030).
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineCharacterPack()` gives plugin authors autocomplete and a
 * compile-time check that the def shape matches `PluginCharacterPackDef`.
 *
 * Mirrors `packages/plugin-sdk/src/define/define-skill.ts` exactly so the helper
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
import { TTS_PROVIDERS } from "@cognia/tts/types"

/**
 * Soft upper bound on characters per pack — keeps the in-memory overlay
 * cost predictable. See ADR-0030 §Risks: 50 × 10 KB systemPrompt = 500 KB
 * per plugin, which is acceptable but should not creep upward silently.
 */
export const PLUGIN_CHARACTER_PACK_SOFT_LIMIT = 50

/**
 * Soft limit on `avatarImage.webDataUrl` length (~64 KB after base64
 * inflation). Crossing this prints a warning but does NOT block — the
 * runtime overlay budget cited in ADR-0030 §Risks is 500 KB per plugin
 * and a single 64 KB avatar already consumes a sizable share. Authors
 * should ship `tauriPath` references for anything larger.
 */
export const PLUGIN_CHARACTER_AVATAR_WEB_DATA_URL_SOFT_BYTES = 64 * 1024

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
    // v2 warnings — do NOT throw; an unknown provider or oversized avatar
    // still loads (the runtime falls back). We surface the issue so the
    // author can fix it before publishing.
    warnIfUnknownVoiceProvider(def.id, ch.localId, ch.voiceProfile?.provider)
    warnIfOversizedAvatarImage(def.id, ch.localId, ch.avatarImage?.webDataUrl)
  }
  return def
}

function warnIfUnknownVoiceProvider(
  packId: string,
  localId: string,
  provider: string | undefined
): void {
  if (!provider) return
  if (Object.prototype.hasOwnProperty.call(TTS_PROVIDERS, provider)) return

  console.warn(
    `defineCharacterPack: pack "${packId}" character "${localId}" declares voiceProfile.provider "${provider}", ` +
      `which is not a known TTS provider. The runtime will fall back to the user's global TTS settings.`
  )
}

function warnIfOversizedAvatarImage(
  packId: string,
  localId: string,
  webDataUrl: string | undefined
): void {
  if (!webDataUrl) return
  if (webDataUrl.length <= PLUGIN_CHARACTER_AVATAR_WEB_DATA_URL_SOFT_BYTES) return

  console.warn(
    `defineCharacterPack: pack "${packId}" character "${localId}" has avatarImage.webDataUrl ` +
      `of ${webDataUrl.length} bytes (soft limit ${PLUGIN_CHARACTER_AVATAR_WEB_DATA_URL_SOFT_BYTES}). ` +
      `Consider shipping a smaller image or using avatarImage.tauriPath instead.`
  )
}
