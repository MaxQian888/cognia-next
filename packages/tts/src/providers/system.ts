/**
 * System TTS — Web Speech API. Ported from
 * `D:\Project\Cognia\lib\ai\tts\providers\system-tts.ts`.
 *
 * The orchestrator drives playback directly via SpeechSynthesisUtterance,
 * but a couple of helpers (voice listing, "is supported?") are useful for
 * the settings UI.
 */

import type { TTSError, TTSResponse } from "../types"
import { getTTSError } from "../types"

export interface SystemTTSOptions {
  voice?: string
  rate?: number
  pitch?: number
  volume?: number
  lang?: string
}

export interface SystemTTSController {
  pause: () => void
  resume: () => void
  cancel: () => void
  onEnd?: () => void
  onError?: (error: TTSError) => void
  onStart?: () => void
  onPause?: () => void
  onResume?: () => void
  onBoundary?: (event: SpeechSynthesisEvent) => void
}

export function isSystemTTSSupported(): boolean {
  if (typeof window === "undefined") return false
  return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window
}

export function getSystemVoices(): SpeechSynthesisVoice[] {
  if (!isSystemTTSSupported()) return []
  return speechSynthesis.getVoices()
}

export function waitForVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!isSystemTTSSupported()) {
      resolve([])
      return
    }
    const voices = speechSynthesis.getVoices()
    if (voices.length > 0) {
      resolve(voices)
      return
    }
    const onChanged = () => {
      const loaded = speechSynthesis.getVoices()
      if (loaded.length > 0) {
        speechSynthesis.onvoiceschanged = null
        resolve(loaded)
      }
    }
    speechSynthesis.onvoiceschanged = onChanged
    setTimeout(() => {
      speechSynthesis.onvoiceschanged = null
      resolve(speechSynthesis.getVoices())
    }, 3000)
  })
}

export function findSystemVoice(voiceName?: string, lang?: string): SpeechSynthesisVoice | null {
  const voices = getSystemVoices()
  if (voiceName) {
    const v = voices.find((v) => v.name === voiceName || v.voiceURI === voiceName)
    if (v) return v
  }
  if (lang) {
    const lc = lang.split("-")[0]
    const v = voices.find((v) => v.lang.startsWith(lc))
    if (v) return v
  }
  return voices[0] ?? null
}

export function speakWithSystemTTS(
  text: string,
  options: SystemTTSOptions = {}
): SystemTTSController {
  const controller: SystemTTSController = {
    pause: () => speechSynthesis.pause(),
    resume: () => speechSynthesis.resume(),
    cancel: () => speechSynthesis.cancel(),
  }
  if (!isSystemTTSSupported()) {
    setTimeout(() => controller.onError?.(getTTSError("not-supported")), 0)
    return controller
  }
  speechSynthesis.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  if (options.voice) {
    const v = findSystemVoice(options.voice, options.lang)
    if (v) utt.voice = v
  } else if (options.lang) {
    const v = findSystemVoice(undefined, options.lang)
    if (v) utt.voice = v
  }
  utt.rate = options.rate ?? 1
  utt.pitch = options.pitch ?? 1
  utt.volume = options.volume ?? 1
  if (options.lang) utt.lang = options.lang
  utt.onstart = () => controller.onStart?.()
  utt.onend = () => controller.onEnd?.()
  utt.onerror = (event) => {
    if (event.error === "canceled" || event.error === "interrupted") {
      controller.onError?.(getTTSError("cancelled"))
    } else {
      controller.onError?.(getTTSError("audio-playback-error", event.error))
    }
  }
  utt.onpause = () => controller.onPause?.()
  utt.onresume = () => controller.onResume?.()
  utt.onboundary = (event) => controller.onBoundary?.(event)
  speechSynthesis.speak(utt)
  return controller
}

export function stopSystemTTS(): void {
  if (isSystemTTSSupported()) speechSynthesis.cancel()
}

export function isSystemTTSSpeaking(): boolean {
  return isSystemTTSSupported() && speechSynthesis.speaking
}

export function isSystemTTSPaused(): boolean {
  return isSystemTTSSupported() && speechSynthesis.paused
}

export async function generateSystemTTSAudio(): Promise<TTSResponse> {
  return {
    success: false,
    error:
      "System TTS does not support audio file generation. Use speakWithSystemTTS for real-time playback.",
  }
}
