// User-facing pet preferences. Persisted as `AppSettings.petSettings` via the
// settings store `save()` action (see `components/settings/pet/pet-section.tsx`).

/** Which corner the floating widget docks to. */
export type PetAnchor = "bottom-right" | "bottom-left" | "top-right" | "top-left"

/** Motion preference: follow the OS, or force on/off regardless. */
export type PetMotionPreference = "auto" | "full" | "reduced"

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
}

export const DEFAULT_PET_DESKTOP_OVERLAY: PetDesktopOverlaySettings = {
  enabled: false,
  clickThrough: false,
  size: 128,
  position: null,
}

export const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: true,
  anchor: "bottom-right",
  motion: "auto",
  mutedBubbles: false,
  size: 96,
  skinId: "svg",
}
