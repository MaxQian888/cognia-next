"use client"

import { SttCard } from "./speech/stt-card"
import { TtsCard } from "./speech/tts-card"

/**
 * Combined Speech section — STT (voice input) + TTS (read-aloud).
 *
 * Mirrors Cognia's `components/settings/system/speech-settings.tsx`. Each
 * card owns its own card chrome; this component just stacks them.
 */
export function SpeechSection() {
  return (
    <div className="space-y-4">
      <SttCard />
      <TtsCard />
    </div>
  )
}
