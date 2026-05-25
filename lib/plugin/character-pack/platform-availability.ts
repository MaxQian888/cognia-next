/**
 * Platform availability for characters (ADR-0030 `availableOnPlatforms`).
 *
 * A character may restrict itself to specific host profiles (e.g. a pack that
 * mixes desktop-only personas with cross-platform ones). When the list is set
 * and excludes the current profile, selection surfaces hide the character.
 * An empty / undefined list means "available everywhere".
 */

import { isTauri } from "@/lib/tauri"
import type { PluginRuntimeProfile } from "@/types/plugin/plugin"

/** The host profile the renderer is currently running in. */
export function currentRuntimeProfile(): PluginRuntimeProfile {
  return isTauri() ? "tauri" : "browser"
}

/**
 * Whether a character with the given `availableOnPlatforms` restriction is
 * usable on `profile` (defaults to the current runtime profile).
 */
export function isAvailableOnProfile(
  availableOnPlatforms: PluginRuntimeProfile[] | undefined,
  profile: PluginRuntimeProfile = currentRuntimeProfile()
): boolean {
  if (!availableOnPlatforms || availableOnPlatforms.length === 0) return true
  return availableOnPlatforms.includes(profile)
}
