// One answer to "may the pet subsystem act in this webview, right now?".
//
// Before this module the same question was asked in three different shapes:
// `PetMount` computed `enabled && !secondary && !isMobile` inline, the command
// registry asked nothing at all, and the plugin API asked only about the `pet`
// capability. Three call sites, three answers, and the two that disagreed with
// `PetMount` were the ones that could still award XP.
//
// The predicate is pure and framework-free on purpose: the React mount, the
// command handlers, the agent tools, and the access gate all need it, and only
// one of those is a component.

import type { Platform } from "@/lib/platform/detect"
import { detectPlatform } from "@/lib/platform/detect"
import { getPetWindowRole, isSecondaryOverlayRole, type PetWindowRole } from "@/lib/pet/window-role"

/**
 * Why the pet may not act here.
 *
 * - `unsupported-host`: the Capacitor mobile shell. The floating widget would
 *   dock to a viewport corner over page content with a 96px hit area, most
 *   visibly covering bottom-right action buttons. The whole subsystem is
 *   excluded there, mirroring the Perf HUD.
 * - `secondary-window`: a transparent least-privilege pet window (overlay or
 *   popup) or another secondary overlay. These render presentation only. The
 *   controller lives solely in the main window, or XP double-awards.
 * - `disabled`: the user turned the pet off in Settings.
 */
export type PetUnavailableReason = "unsupported-host" | "secondary-window" | "disabled"

export type PetAvailability =
  { available: true } | { available: false; reason: PetUnavailableReason }

export interface PetAvailabilityInput {
  /** `PetSettings.enabled`. */
  enabled: boolean
  /** Which window this webview is. */
  role: PetWindowRole
  /** Runtime platform of this webview. */
  platform: Platform
}

const AVAILABLE: PetAvailability = { available: true }

/**
 * Pure availability decision.
 *
 * Structural reasons are reported before the setting: "you are in the overlay
 * window" and "you are on mobile" stay true no matter what the user toggles,
 * so surfacing them first gives a caller the reason it can actually act on
 * rather than one that would still be wrong after flipping the switch.
 */
export function resolvePetAvailability(input: PetAvailabilityInput): PetAvailability {
  if (input.platform === "mobile") return { available: false, reason: "unsupported-host" }
  if (isSecondaryOverlayRole(input.role)) return { available: false, reason: "secondary-window" }
  if (!input.enabled) return { available: false, reason: "disabled" }
  return AVAILABLE
}

/** Convenience boolean for call sites that do not render the reason. */
export function isPetAvailable(input: PetAvailabilityInput): boolean {
  return resolvePetAvailability(input).available
}

/**
 * Live variant for non-React callers (command handlers, agent tools, the
 * access gate). Reads the window role and platform from the environment. The
 * caller still supplies `enabled` because the settings store is its own
 * concern, and injecting it keeps this module free of a store import.
 */
export function resolveLivePetAvailability(
  enabled: boolean,
  deps: { role?: PetWindowRole; platform?: Platform } = {}
): PetAvailability {
  return resolvePetAvailability({
    enabled,
    role: deps.role ?? getPetWindowRole(),
    platform: deps.platform ?? detectPlatform(),
  })
}
