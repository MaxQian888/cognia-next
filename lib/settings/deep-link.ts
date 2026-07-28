/**
 * Typed builder for settings deep links.
 *
 * Before this, every "Open settings" affordance in the app hand-wrote its own
 * URL — `router.push("/settings?section=characters")`, `<Link
 * href="/settings?section=external-bridge">`, and so on across ~30 call sites.
 * A typo produced a link that silently landed on the default section, and there
 * was no way to point at a *control* rather than a section, so "Open settings"
 * from an auth failure dropped the user at the top of a long pane to hunt for
 * the API-key field themselves.
 *
 * Typing `section` on {@link SettingsSectionId} turns a typo into a compile
 * error, and `focus` emits the `?focus=` param that
 * `hooks/settings/use-setting-focus.ts` already consumes (scroll into view,
 * pulse a highlight ring, strip the param).
 *
 * Type-only import of the section union keeps this module free of the settings
 * component graph.
 */

import type { SettingsSectionId } from "@/components/settings/settings-nav-config"

export const SETTINGS_ROUTE = "/settings" as const

/**
 * `use-setting-focus` guards its `[data-setting-id="…"]` selector with this
 * pattern, so an id it would reject is a link that silently does nothing.
 * Mirrored here to drop the param instead of emitting a dud.
 */
const CONTROL_ID = /^[a-z0-9-]+$/i

/**
 * Build a settings URL.
 *
 * @param section  Target pane.
 * @param focus    Optional `data-setting-id` of a control to scroll to and
 *                 highlight. Ignored when it isn't a plain control id.
 */
export function settingsHref(section: SettingsSectionId, focus?: string): string {
  const params = new URLSearchParams({ section })
  if (focus && CONTROL_ID.test(focus)) params.set("focus", focus)
  return `${SETTINGS_ROUTE}?${params.toString()}`
}
