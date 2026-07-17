/**
 * Imperative "read this chat message aloud" entry point.
 *
 * Deliberately NOT a hook: both the per-message `ReadAloudButton` and the
 * `useChatAutoPlayTTS` auto-play hook call this, and neither should subscribe
 * to the orchestrator's progress stream just to start playback. It reads the
 * freshest settings + provider keys straight from the store, resolves the
 * (optional) per-character voice overlay, and hands off to the singleton
 * orchestrator — the single speak path for chat.
 *
 * Mirrors the body of `useTTS.speak` minus the React subscription, so the
 * caching / chunking / cancellation pipeline is reused 1:1.
 */

import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"
import { selectSpeechSettings } from "@/lib/tts/speech-settings"
import { providerKeyMapToSettingsMap } from "@/lib/tts/keyring"
import {
  resolveCharacterVoice,
  type CharacterVoiceSource,
} from "@/lib/plugin/character-pack/character-voice"
import { useSettingsStore } from "@/stores/settings"

export interface SpeakChatMessageArgs {
  /** The owning surface id (chat message id) — surfaced as `activeSourceId`. */
  messageId: string
  /** Plain text to synthesize (already extracted from the message parts). */
  text: string
  /**
   * The character that "spoke" this message, if any. Its `voiceProfile` is
   * projected into a SpeechSettings overlay so team members read in distinct
   * voices. `null`/`undefined` falls through to the global voice.
   */
  character?: CharacterVoiceSource | null
}

/**
 * Start reading a chat message aloud. Resolves once playback finishes (or
 * rejects if synthesis fails — the orchestrator already toasts in that case).
 * Returns early without speaking when there is no text.
 */
export async function speakChatMessage({
  messageId,
  text,
  character,
}: SpeakChatMessageArgs): Promise<void> {
  if (!text.trim()) return

  // Lazily load provider keys on first playback (same contract as useTTS).
  await useSettingsStore.getState().ensureProviderKeys()
  const store = useSettingsStore.getState()

  const base = selectSpeechSettings(store.settings)
  const overlay = character ? resolveCharacterVoice(character) : undefined
  const speechSettings = overlay ? { ...base, ...overlay } : base
  const providerSettings = providerKeyMapToSettingsMap(store.providerKeys)

  await ttsOrchestrator.speak(text, {
    source: "chat",
    sourceId: messageId,
    speechSettings,
    providerSettings,
  })
}

export interface SpeakChatMessageStreamArgs {
  /** The owning surface id (chat message id). */
  messageId: string
  /** The character that "spoke" this message, if any (voice overlay). */
  character?: CharacterVoiceSource | null
}

/**
 * Streaming twin of {@link speakChatMessage}: reads a live token stream (the
 * assistant's text as it generates) so synthesis starts before the reply is
 * finished. Resolves the same settings + character overlay, then hands off to
 * the orchestrator's `speakStream`.
 */
export async function speakChatMessageStream(
  tokens: AsyncIterable<string>,
  { messageId, character }: SpeakChatMessageStreamArgs
): Promise<void> {
  await useSettingsStore.getState().ensureProviderKeys()
  const store = useSettingsStore.getState()

  const base = selectSpeechSettings(store.settings)
  const overlay = character ? resolveCharacterVoice(character) : undefined
  const speechSettings = overlay ? { ...base, ...overlay } : base
  const providerSettings = providerKeyMapToSettingsMap(store.providerKeys)

  await ttsOrchestrator.speakStream(tokens, {
    source: "chat",
    sourceId: messageId,
    speechSettings,
    providerSettings,
  })
}
