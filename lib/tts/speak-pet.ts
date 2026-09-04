/**
 * Give the desktop pet a voice. The counterpart of `speakChatMessage` for the
 * pet's `talked` replies: the pet used to only show a text bubble. This reads
 * the freshest settings + provider keys, overlays the bound character's voice
 * (reusing `resolveCharacterVoice`, same as chat), and hands off to the
 * singleton orchestrator. A no-op when TTS is disabled (the orchestrator's own
 * `speak` short-circuits on `!ttsEnabled`), so no separate pet-voice toggle.
 */

import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"
import { selectSpeechSettings } from "@/lib/tts/speech-settings"
import { providerKeyMapToSettingsMap } from "@/lib/tts/keyring"
import {
  resolveCharacterVoice,
  type CharacterVoiceSource,
} from "@/lib/plugin/character-pack/character-voice"
import { useSettingsStore } from "@/stores/settings"
import { hasNoLeakingPii } from "@cognia/redact"

/**
 * Speak a pet bubble aloud. Returns early without speaking when there is no
 * text, and resolves once playback finishes (or rejects if synthesis fails,
 * where the orchestrator toasts). The caller should fire-and-forget so a
 * synthesis failure never breaks the bubble.
 *
 * The text passes the PII gate first. Synthesis is a SECOND outbound hop: the
 * reply already went to a model, and a cloud voice provider is a different
 * vendor that has not seen it. The pet's reply can also echo back a fact
 * recalled from long-term memory, so gating only the prompt would let the
 * model launder it into the audio path. Refusing here shows the bubble
 * silently, which is the right degradation for a cosmetic voice.
 */
export async function speakPetText(
  text: string,
  character?: CharacterVoiceSource | null
): Promise<void> {
  if (!text.trim()) return
  if (!hasNoLeakingPii(text)) return

  await useSettingsStore.getState().ensureProviderKeys()
  const store = useSettingsStore.getState()

  const base = selectSpeechSettings(store.settings)
  const overlay = character ? resolveCharacterVoice(character) : undefined
  const speechSettings = overlay ? { ...base, ...overlay } : base
  const providerSettings = providerKeyMapToSettingsMap(store.providerKeys)

  await ttsOrchestrator.speak(text, {
    source: "pet",
    speechSettings,
    providerSettings,
  })
}
