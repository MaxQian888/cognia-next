// User-facing pet preferences. Persisted as `AppSettings.petSettings` via the
// settings store `save()` action (see `components/settings/pet/pet-section.tsx`).

import type { UtilityModelConfig } from "@/lib/claude/types"

/** Which corner the floating widget docks to. */
export type PetAnchor = "bottom-right" | "bottom-left" | "top-right" | "top-left"

/** Motion preference: follow the OS, or force on/off regardless. */
export type PetMotionPreference = "auto" | "full" | "reduced"

/** How often the overlay pet starts a wander walk on its own. */
export type PetWanderFrequency = "calm" | "normal" | "lively"

/** How far a single wander walk may travel. */
export type PetWanderRange = "full" | "near"

/**
 * Autonomous wandering preferences for the desktop overlay pet (VPet-style
 * "smart move"). The in-app widget never wanders — it stays anchored.
 */
export interface PetWanderSettings {
  /** Master wander switch. Reduced motion always wins over this. */
  enabled: boolean
  /** Rest-interval bucket between walks. */
  frequency: PetWanderFrequency
  /** Only start a walk within a short window after a user interaction. */
  onlyAfterInteraction: boolean
  /** Walk targets span the whole work area, or stay near the current spot. */
  range: PetWanderRange
}

/**
 * Transparent always-on-top desktop-pet overlay window settings (Tauri only).
 * The overlay window's screen position is the single source of truth here —
 * the window-state plugin denylists the "pet" window so this field owns it.
 */
export interface PetDesktopOverlaySettings {
  /** Whether the desktop-pet overlay window is open. */
  enabled: boolean
  /** Whether the overlay ignores cursor events (click-through). */
  clickThrough: boolean
  /** Render box size in px for the overlay pet. */
  size: number
  /** Persisted absolute screen position, or null to center on first open. */
  position?: { x: number; y: number } | null
  /** Autonomous wandering preferences. Absent = defaults (disabled). */
  wander?: PetWanderSettings
}

/**
 * Optional pet sound effects (default OFF). Short WebAudio-synthesized blips on
 * touch / reaction / level-up. Absent = disabled.
 */
export interface PetSoundSettings {
  /** Master switch (default false). */
  enabled: boolean
  /** Output volume 0–1 (default 0.5). */
  volume?: number
  /** Optional quiet-hours window (24h ints) that silences SFX; null = always on. */
  quietHours?: { start: number; end: number } | null
}

/** Frequency tier for proactive speech (maps to gap/cap/idle tunings). */
export type PetProactiveTier = "quiet" | "normal" | "chatty"

/**
 * Proactive speech preferences (the pet speaks unprompted). Default OFF —
 * requires `llmSpeak.enabled` too, since utterances ride the same side channel.
 */
export interface PetProactiveSettings {
  /** Master proactive switch. */
  enabled: boolean
  /** How chatty: quiet / normal / chatty. */
  tier: PetProactiveTier
  /** Comment on milestones (level-up, evolution, goals, achievements, workflows). */
  eventComments: boolean
  /** Speak up after long user inactivity. */
  idleChatter: boolean
  /** Morning greeting + late-night rest reminder. */
  timeGreetings: boolean
}

export interface PetSettings {
  /** Master switch — when false the widget never mounts. */
  enabled: boolean
  /** Dock corner for the floating widget. */
  anchor: PetAnchor
  /** Override `prefers-reduced-motion`. */
  motion: PetMotionPreference
  /** Silence template + LLM bubbles (the pet still animates). */
  mutedBubbles: boolean
  /** Render box size in px. */
  size: number
  /**
   * Which skin renders the pet. `"svg"` is the built-in vector mascot;
   * `"live2d"` renders a user-imported Live2D model. Defaults to `"svg"`.
   */
  skinId?: string
  /**
   * Id of the globally-active Live2D model (a `petModels` row). The skin
   * resolver prefers a per-character binding override when present.
   */
  activeLive2dModelId?: string
  /** Transparent desktop-pet overlay window settings (Tauri only). */
  desktopPet?: PetDesktopOverlaySettings
  /**
   * Low-power mode: caps the Live2D ticker at 30 fps, disables canvas
   * antialiasing at init, and lengthens wander rest intervals.
   */
  lowPower?: boolean
  /**
   * Opt-in LLM speak for the talk interaction (`speakAsPet` side channel).
   * Absent or `enabled: false` → talk shows a template bubble only; the pet
   * never spends a token. Mirrors the `labelSummary` utility-config pattern:
   * optional provider/model override, resolved by `buildUtilityLlmClient`.
   */
  llmSpeak?: UtilityModelConfig
  /** Proactive speech preferences. Absent = defaults (disabled). */
  proactive?: PetProactiveSettings
  /**
   * Pet conversation memory (rolling history fed back into the prompt).
   * Absent = enabled — turning it off stops recording AND injecting history.
   */
  petMemory?: { enabled: boolean }
  /**
   * Gentle Notification Center alert when the pet first becomes unwell from
   * sustained neglect. Absent = enabled; turning it off keeps the visual
   * condition + recovery but suppresses the notification.
   */
  careAlerts?: boolean
  /** Optional sound effects (default OFF). */
  sound?: PetSoundSettings
}

export const DEFAULT_PET_WANDER: PetWanderSettings = {
  enabled: false,
  frequency: "normal",
  onlyAfterInteraction: false,
  range: "full",
}

export const DEFAULT_PET_DESKTOP_OVERLAY: PetDesktopOverlaySettings = {
  enabled: false,
  clickThrough: false,
  size: 128,
  position: null,
  wander: DEFAULT_PET_WANDER,
}

export const DEFAULT_PET_SOUND: PetSoundSettings = {
  enabled: false,
  volume: 0.5,
  quietHours: null,
}

export const DEFAULT_PET_PROACTIVE: PetProactiveSettings = {
  enabled: false,
  tier: "normal",
  eventComments: true,
  idleChatter: true,
  timeGreetings: true,
}

export const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: true,
  anchor: "bottom-right",
  motion: "auto",
  mutedBubbles: false,
  size: 96,
  skinId: "svg",
  lowPower: false,
}
