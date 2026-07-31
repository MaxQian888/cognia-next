/* istanbul ignore file -- thin WebAudio edge; all policy is tested in sfx-gate.ts */
// Lazily-created, SSR-safe WebAudio player for the pet's optional blips. No
// bundled assets — each cue is synthesized from a short oscillator envelope, so
// "degrade silently if assets missing" is automatic. Every play is guarded by
// the pure `shouldPlaySfx` gate and wrapped in try/catch; a missing AudioContext
// (SSR / tests / unsupported browser) is a no-op.

import type { PetSoundSettings } from "@/types/pet"
import {
  effectiveGain,
  resolveSfxCue,
  shouldPlaySfx,
  type PetSfxEvent,
  type SfxGateCtx,
} from "./sfx-gate"

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!audioCtx) {
    try {
      audioCtx = new Ctor()
    } catch {
      return null
    }
  }
  return audioCtx
}

/** Play a short blip for the given event, subject to the pure gate. Never throws. */
export function playPetSfx(
  event: PetSfxEvent,
  settings: PetSoundSettings | undefined,
  ctx: Omit<SfxGateCtx, "event">
): void {
  if (!shouldPlaySfx(settings, { ...ctx, event })) return
  const audio = getAudioContext()
  if (!audio) return
  try {
    const cue = resolveSfxCue(event)
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = cue.type
    osc.frequency.value = cue.freq
    const now = audio.currentTime
    const peak = Math.max(0.0001, effectiveGain(settings, cue))
    const endAt = now + cue.durationMs / 1000
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt)
    osc.connect(gain).connect(audio.destination)
    osc.start(now)
    osc.stop(endAt + 0.02)
  } catch {
    // Silent degrade — audio must never disrupt the pet.
  }
}
