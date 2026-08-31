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

export interface SettingsHrefOptions {
  /**
   * `data-setting-id` of a control to scroll to and highlight. Ignored when it
   * isn't a plain control id.
   */
  focus?: string
  /**
   * Extra params owned by the target section. Undefined and empty values are
   * dropped, so a caller can pass an optional selection without branching.
   */
  params?: Readonly<Record<string, string | undefined>>
}

/**
 * Build a settings URL.
 *
 * @param section  Target pane.
 * @param options  A bare `data-setting-id` string (the original signature), or
 *                 `{ focus, params }`.
 */
export function settingsHref(
  section: SettingsSectionId,
  options?: string | SettingsHrefOptions
): string {
  const { focus, params }: SettingsHrefOptions =
    typeof options === "string" ? { focus: options } : (options ?? {})
  const search = new URLSearchParams({ section })
  if (focus && CONTROL_ID.test(focus)) search.set("focus", focus)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") search.set(key, value)
  }
  return `${SETTINGS_ROUTE}?${search.toString()}`
}

// ---------------------------------------------------------------------------
// Section-specific builders. One per section that owns URL params beyond
// `section`, and each one IS that section's param contract:
// `connections-section.tsx` reads `connectionsTab`, `use-selected-adapter.ts`
// reads `adapter`, `adapters-tab.tsx` reads `platform`, and the MCP panel
// reads `preset`. A caller deep-linking into one of those should not have to
// know the spelling, which is how six call sites came to emit
// `/settings/connections?tab=outbound`: a path that does not exist under
// `output: "export"` (there is one `app/settings/page.tsx` and no nested
// routes) carrying a param name nothing reads.
// ---------------------------------------------------------------------------

/** Tab ids of the Connections section. Mirrors `ConnectionsTabId`. */
export type ConnectionsDeepLinkTab =
  "overview" | "adapters" | "overrides" | "outbound" | "audit" | "capability" | "assets"

export interface ConnectionsDeepLink {
  tab?: ConnectionsDeepLinkTab
  /** Select one configured adapter instance by row id (`?adapter=`). */
  adapter?: string
  /**
   * Land on a platform kind rather than an instance (`?platform=`). Selects
   * that platform's first configured instance, or opens its "add" dialog when
   * there is none. Implies the `adapters` tab.
   */
  platform?: string
}

export function connectionsHref(link: ConnectionsDeepLink = {}): string {
  const tab = link.tab ?? (link.adapter || link.platform ? "adapters" : undefined)
  return settingsHref("connections", {
    params: { connectionsTab: tab, adapter: link.adapter, platform: link.platform },
  })
}

export interface McpDeepLink {
  /** Open the preset gallery on this catalog entry. */
  preset?: string
  /**
   * Open the detail pane for one configured server (`?server=`). This is how a
   * managed external service points at the MCP row it provisioned, so its
   * "pending review" state has somewhere to lead.
   */
  server?: string
}

/** Deep-link into the MCP section, optionally opening one preset or server. */
export function mcpHref(link: McpDeepLink = {}): string {
  return settingsHref("mcp", { params: { preset: link.preset, server: link.server } })
}
