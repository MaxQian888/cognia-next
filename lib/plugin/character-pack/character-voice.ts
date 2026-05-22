/**
 * Character voice resolver (ADR-0030 v2).
 *
 * Projects a character's optional `voiceProfile` into a partial
 * {@link SpeechSettings} overlay the caller can spread onto the
 * AppSettings-derived speech settings before handing them to
 * `TTSOrchestrator.speak()`. Never mutates `AppSettings`.
 *
 * The orchestrator's per-provider voice id is stored under
 * `<provider>Voice` (e.g. `openaiVoice`, `edgeVoice`), so this resolver
 * also switches the active provider via `ttsProvider`. `rate` / `pitch` /
 * `volume` overlay the global controls when set.
 *
 * Unknown provider ids do not produce an overlay — the caller continues
 * to use the AppSettings defaults. We do NOT warn here because
 * `defineCharacterPack` already does that at SDK validate time; the
 * runtime path stays silent so a stale pack doesn't spam the console.
 */

import type { Character } from "@/lib/claude/types"
import type { PluginCharacterDef } from "@/types/plugin/plugin-character-pack"
import { type SpeechSettings, type TTSProvider, TTS_PROVIDERS } from "@/lib/tts/types"

/** Per-provider voice-id field on {@link SpeechSettings}. */
const PROVIDER_VOICE_FIELD: Record<TTSProvider, keyof SpeechSettings> = {
  system: "systemVoice",
  openai: "openaiVoice",
  gemini: "geminiVoice",
  edge: "edgeVoice",
  elevenlabs: "elevenlabsVoice",
  lmnt: "lmntVoice",
  hume: "humeVoice",
  cartesia: "cartesiaVoice",
  deepgram: "deepgramVoice",
  xiaomi: "xiaomiVoice",
}

/**
 * Argument shape accepted by {@link resolveCharacterVoice}. We deliberately
 * narrow to the only field we need so the function can be called both
 * with a Dexie `Character` row and an in-memory `PluginCharacterDef`
 * without coercion.
 */
export type CharacterVoiceSource = Pick<Character | PluginCharacterDef, "voiceProfile">

/**
 * Return value — a partial SpeechSettings ready to be spread on top of the
 * AppSettings-derived base. `undefined` when the character has no
 * voiceProfile (caller should fall through to global defaults).
 */
export type CharacterVoiceOverlay = Partial<SpeechSettings>

export function resolveCharacterVoice(
  character: CharacterVoiceSource
): CharacterVoiceOverlay | undefined {
  const profile = character.voiceProfile
  if (!profile) return undefined
  // Defensive: the SDK validate-time check warns but doesn't block, so an
  // unknown provider string could still reach runtime. Treat it as "no
  // overlay" — caller's AppSettings defaults take over.
  if (!isKnownTtsProvider(profile.provider)) return undefined
  if (!profile.voiceId.trim()) return undefined

  const overlay: CharacterVoiceOverlay = {
    ttsProvider: profile.provider,
  }
  const voiceField = PROVIDER_VOICE_FIELD[profile.provider]
  ;(overlay as Record<string, unknown>)[voiceField] = profile.voiceId
  if (profile.rate !== undefined) overlay.ttsRate = profile.rate
  if (profile.pitch !== undefined) overlay.ttsPitch = profile.pitch
  if (profile.volume !== undefined) overlay.ttsVolume = profile.volume
  return overlay
}

function isKnownTtsProvider(provider: string): provider is TTSProvider {
  return Object.prototype.hasOwnProperty.call(TTS_PROVIDERS, provider)
}
