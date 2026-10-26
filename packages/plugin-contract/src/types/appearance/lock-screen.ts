// Lock-screen appearance.
//
// The lock screen is the first thing seen on every cold start and every
// return from idle, and until now it was a card on a flat background. This
// makes it configurable, with one rule running through every option: nothing
// here may make the screen harder to unlock.
//
// Concretely, that rule decides three things that would otherwise be
// judgement calls:
//
//   - The input card always sits on its own surface, whatever the backdrop
//     is doing. A wallpaper behind a password field is decoration, and
//     decoration must not cost contrast.
//   - Widgets are OPT-IN and default off. A lock screen exists because the
//     content behind it is not for whoever is standing there, so showing
//     unread counts on it needs to be a decision, not a default.
//   - Motion has an off switch that is honoured independently of the app's
//     global reduce-motion setting, because a user may want the app lively
//     and the lock screen still.
//
// Persistence rides on `AppSettings.lockScreen`. No new table.

/** Where the lock screen's backdrop comes from. */
export type LockScreenBackdrop =
  /** The plain themed background. The historical look. */
  | "theme"
  /** Whatever wallpaper the app is currently showing, rotation included. */
  | "wallpaper"
  /** One specific wallpaper, pinned independently of the app's. */
  | "pinned"
  /** A single flat colour. */
  | "solid"

export const LOCK_SCREEN_BACKDROPS: readonly LockScreenBackdrop[] = [
  "theme",
  "wallpaper",
  "pinned",
  "solid",
]

/** Clock presentation. `none` hides it entirely. */
export type LockScreenClock = "none" | "time" | "timeAndDate"

export const LOCK_SCREEN_CLOCKS: readonly LockScreenClock[] = ["none", "time", "timeAndDate"]

/** Hour cycle. `auto` follows the app locale. */
export type LockScreenHourCycle = "auto" | "h12" | "h23"

export const LOCK_SCREEN_HOUR_CYCLES: readonly LockScreenHourCycle[] = ["auto", "h12", "h23"]

/**
 * The line above the clock.
 *
 * `timeOfDay` is a greeting chosen from the hour. `custom` is the user's own
 * text, which is rendered as plain text and never as markup.
 */
export type LockScreenGreeting = "none" | "timeOfDay" | "custom"

export const LOCK_SCREEN_GREETINGS: readonly LockScreenGreeting[] = ["none", "timeOfDay", "custom"]

/**
 * Ambient motion behind the card.
 *
 * Independent of the app's global reduce-motion switch on purpose. Someone can
 * reasonably want an animated app and a still lock screen, or the reverse, and
 * collapsing the two would silently override whichever they set second.
 * `respectSystemMotion` below is what ties this back to the OS preference.
 */
export type LockScreenMotion = "none" | "drift" | "aurora"

export const LOCK_SCREEN_MOTIONS: readonly LockScreenMotion[] = ["none", "drift", "aurora"]

/** Bounds on the backdrop treatment. */
export const MAX_LOCK_BLUR_PX = 40
export const MIN_LOCK_BLUR_PX = 0

/** Longest custom greeting accepted. Long enough for a sentence, short enough to fit. */
export const MAX_GREETING_LENGTH = 64

export interface LockScreenSettings {
  backdrop: LockScreenBackdrop
  /**
   * Wallpaper id used when `backdrop === "pinned"`. Null falls back to the
   * theme backdrop rather than to nothing, so a deleted wallpaper degrades to
   * a working screen instead of a blank one.
   */
  pinnedWallpaperId: string | null
  /** CSS colour used when `backdrop === "solid"`. */
  solidColor: string
  /** Blur applied to the backdrop only, never to the card. */
  blurPx: number
  /**
   * Darkening applied over the backdrop, 0..1.
   *
   * The reason a wallpaper backdrop is legible at all. Defaults high enough
   * that a bright photograph still leaves the card readable.
   */
  dim: number
  clock: LockScreenClock
  hourCycle: LockScreenHourCycle
  greeting: LockScreenGreeting
  /** Plain text. Rendered as text, never as markup. */
  customGreeting: string
  motion: LockScreenMotion
  /**
   * Collapse motion to `none` under `prefers-reduced-motion: reduce`.
   *
   * Separate from {@link motion} so "I want aurora" and "but not when the
   * system asks for stillness" stay two answers rather than one.
   */
  respectSystemMotion: boolean
  /**
   * Show the account avatar. Off is a real choice: on a shared or public
   * machine the avatar is a face and a name to anyone who walks past.
   */
  showAvatar: boolean
}

export const DEFAULT_LOCK_SCREEN: LockScreenSettings = {
  backdrop: "theme",
  pinnedWallpaperId: null,
  solidColor: "#0f172a",
  blurPx: 12,
  dim: 0.45,
  clock: "none",
  hourCycle: "auto",
  greeting: "none",
  customGreeting: "",
  motion: "none",
  respectSystemMotion: true,
  showAvatar: true,
}

/** Narrow an arbitrary value to a {@link LockScreenBackdrop}. */
export function isLockScreenBackdrop(value: unknown): value is LockScreenBackdrop {
  return LOCK_SCREEN_BACKDROPS.includes(value as LockScreenBackdrop)
}

/** Clamp a backdrop blur into the supported range. */
export function clampLockBlur(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_LOCK_SCREEN.blurPx
  return Math.min(MAX_LOCK_BLUR_PX, Math.max(MIN_LOCK_BLUR_PX, Math.round(px)))
}

/** Clamp the backdrop dim into 0..1. */
export function clampLockDim(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOCK_SCREEN.dim
  return Math.min(1, Math.max(0, value))
}

/** Trim and cap a custom greeting. */
export function normalizeGreeting(value: string): string {
  return value.trim().slice(0, MAX_GREETING_LENGTH)
}

/**
 * Which greeting key the time of day maps to.
 *
 * Boundaries are the conventional English ones. They are exposed as a function
 * rather than inlined so the lock screen and the settings preview cannot drift
 * into disagreeing about what "evening" means.
 */
export function greetingKeyForHour(hour: number): "morning" | "afternoon" | "evening" | "night" {
  if (hour >= 5 && hour < 12) return "morning"
  if (hour >= 12 && hour < 18) return "afternoon"
  if (hour >= 18 && hour < 22) return "evening"
  return "night"
}
