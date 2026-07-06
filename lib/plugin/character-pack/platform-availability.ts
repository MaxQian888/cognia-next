/**
 * Platform availability for characters (ADR-0030 `availableOnPlatforms`).
 *
 * A character may restrict itself to specific host profiles (e.g. a pack that
 * mixes desktop-only personas with cross-platform ones). When the list is set
 * and excludes the current profile, selection surfaces hide the character.
 * An empty / undefined list means "available everywhere".
 */

import { detectPlatform } from "@/lib/platform/detect"
import type { PluginRuntimeProfile } from "@/types/plugin/plugin"

/**
 * The host profile the renderer is currently running in. Maps the platform
 * detector's `"web"` to the plugin system's `"browser"` surface; tauri and
 * mobile pass through. (Tauri wins over mobile when both are somehow present.)
 */
export function currentRuntimeProfile(): PluginRuntimeProfile {
  const platform = detectPlatform()
  if (platform === "tauri") return "tauri"
  if (platform === "mobile") return "mobile"
  return "browser"
}

/**
 * Whether a character with the given `availableOnPlatforms` restriction is
 * usable on `profile` (defaults to the current runtime profile).
 *
 * Mobile is a browser-class runtime: on `"mobile"` a list entry of `"browser"`
 * also counts as a match, so a pack authored as `["browser", "tauri"]` (i.e.
 * "everything except… nothing") still shows on the Capacitor shell. A pack must
 * list `"tauri"` only to stay desktop-exclusive, or `"mobile"` to opt into a
 * mobile-only surface.
 */
export function isAvailableOnProfile(
  availableOnPlatforms: PluginRuntimeProfile[] | undefined,
  profile: PluginRuntimeProfile = currentRuntimeProfile()
): boolean {
  if (!availableOnPlatforms || availableOnPlatforms.length === 0) return true
  if (availableOnPlatforms.includes(profile)) return true
  // Mobile inherits browser-targeted availability.
  return profile === "mobile" && availableOnPlatforms.includes("browser")
}
