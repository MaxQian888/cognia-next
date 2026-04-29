/**
 * Auto-play gating for assistant responses. Ported from
 * `D:\Project\Cognia\lib\ai\tts\auto-play-gates.ts`.
 *
 * Use during chat-completion: only kick off TTS once both flags are on AND
 * the message is no longer streaming. Call sites pass the live values, this
 * module just centralises the predicate so the rule lives in one place.
 */

export interface TTSAutoPlayGateInput {
  ttsEnabled: boolean
  ttsAutoPlay: boolean
  isLoading: boolean
  isStreaming: boolean
}

export function canAutoPlayTTS({
  ttsEnabled,
  ttsAutoPlay,
  isLoading,
  isStreaming,
}: TTSAutoPlayGateInput): boolean {
  return ttsEnabled && ttsAutoPlay && !isLoading && !isStreaming
}
