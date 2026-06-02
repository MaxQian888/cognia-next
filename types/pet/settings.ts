// User-facing pet preferences. Persisted as `AppSettings.petSettings` via the
// settings store `save()` action (see `components/settings/pet/pet-section.tsx`).

/** Which corner the floating widget docks to. */
export type PetAnchor = "bottom-right" | "bottom-left" | "top-right" | "top-left"

/** Motion preference: follow the OS, or force on/off regardless. */
export type PetMotionPreference = "auto" | "full" | "reduced"

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
}

export const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: true,
  anchor: "bottom-right",
  motion: "auto",
  mutedBubbles: false,
  size: 96,
}
