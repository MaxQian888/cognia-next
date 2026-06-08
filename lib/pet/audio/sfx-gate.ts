// Pure gating + cue selection for the optional pet sound effects. All policy
// (which sound, volume clamp, quiet hours, autoplay-safety) lives here so the
// thin WebAudio edge in `sfx.ts` stays trivial. Default OFF — `shouldPlaySfx`
// returns false unless the user explicitly enabled sound.

import type { PetSoundSettings } from "@/types/pet"

export type PetSfxEvent = "touch" | "reaction" | "levelUp"

/** Synthesis recipe for one cue (a short oscillator blip). */
export interface SfxCue {
  freq: number
  durationMs: number
  type: OscillatorType
  /** Per-cue gain multiplier (combined with the user volume). */
  gain: number
}

export const SFX_CUES: Record<PetSfxEvent, SfxCue> = {
  touch: { freq: 880, durationMs: 90, type: "sine", gain: 0.5 },
  reaction: { freq: 660, durationMs: 130, type: "triangle", gain: 0.45 },
  levelUp: { freq: 1175, durationMs: 240, type: "square", gain: 0.5 },
}

export function resolveSfxCue(event: PetSfxEvent): SfxCue {
  return SFX_CUES[event]
}

/** Clamp the user volume into [0, 1], default 0.5 for non-finite input. */
export function clampVolume(v: number | undefined): number {
  if (!Number.isFinite(v)) return 0.5
  return Math.max(0, Math.min(1, v as number))
}

/** True when `nowHour` (0–23) falls in the quiet window (handles wrap-around). */
export function isWithinQuietHours(
  nowHour: number,
  quiet: { start: number; end: number } | null | undefined
): boolean {
  if (!quiet) return false
  const { start, end } = quiet
  if (start === end) return false
  if (start < end) return nowHour >= start && nowHour < end
  return nowHour >= start || nowHour < end // wraps past midnight
}

export interface SfxGateCtx {
  reducedMotion: boolean
  /** Local hour 0–23 for quiet-hours evaluation. */
  nowHour: number
  /** True when the play originates from a direct user gesture (autoplay safety). */
  isUserGesture: boolean
  event: PetSfxEvent
}

/** Central gate — every reason to stay silent in one pure predicate. */
export function shouldPlaySfx(settings: PetSoundSettings | undefined, ctx: SfxGateCtx): boolean {
  if (!settings?.enabled) return false
  if (ctx.reducedMotion) return false
  if (isWithinQuietHours(ctx.nowHour, settings.quietHours ?? null)) return false
  // A "touch" cue must ride a real user gesture (browser autoplay policy); the
  // reaction/levelUp cues are allowed post-interaction once the context unlocks.
  if (ctx.event === "touch" && !ctx.isUserGesture) return false
  return true
}

/** Final output gain = clamped user volume × the cue's own gain. */
export function effectiveGain(settings: PetSoundSettings | undefined, cue: SfxCue): number {
  return clampVolume(settings?.volume) * cue.gain
}
