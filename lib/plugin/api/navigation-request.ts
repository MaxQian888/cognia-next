/**
 * `ctx.ui.navigate(href)` — how a plugin asks the shell to change route.
 *
 * Plugin components render inside the host tree but cannot use the host's
 * router: `next/navigation` is not a module the plugin loader shares, so a
 * bundle that imports it carries its own copy with no App Router context and
 * `useRouter()` throws. Two MCP setup dialogs did exactly that to send the
 * user to Settings → MCP. The request instead travels as a DOM event on
 * `window` (the same seam as `requestCommandPalette`) and the always-mounted
 * plugin runtime initializer performs it with the real router.
 *
 * Only in-app paths are accepted: an absolute URL, a protocol-relative `//`
 * href or a `javascript:` string is refused, so a plugin cannot use this to
 * leave the app or run script.
 */

export const PLUGIN_NAVIGATION_REQUEST_EVENT = "cognia:plugin:navigate"

export interface PluginNavigationRequestDetail {
  pluginId: string
  href: string
}

/** An in-app path: starts with a single `/`, carries no scheme or backslash. */
export function isInAppHref(href: string): boolean {
  if (typeof href !== "string" || href.length === 0 || href.length > 2048) return false
  if (!href.startsWith("/") || href.startsWith("//")) return false
  if (href.includes("\\")) return false
  // Reject anything a URL parser would resolve to another origin.
  try {
    return new URL(href, "https://cognia.invalid").origin === "https://cognia.invalid"
  } catch {
    return false
  }
}

/** Dispatch the request. Returns `false` (and dispatches nothing) for a non-app href. */
export function requestPluginNavigation(pluginId: string, href: string): boolean {
  if (!isInAppHref(href)) return false
  if (typeof window === "undefined") return false
  window.dispatchEvent(
    new CustomEvent<PluginNavigationRequestDetail>(PLUGIN_NAVIGATION_REQUEST_EVENT, {
      detail: { pluginId, href },
    })
  )
  return true
}

/** Subscribe the router bridge; returns the unsubscribe. */
export function onPluginNavigationRequest(
  handler: (detail: PluginNavigationRequestDetail) => void
): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PluginNavigationRequestDetail>).detail
    // Re-check on the receiving side: the event name is public, so anything on
    // the page can dispatch it.
    if (detail && typeof detail.pluginId === "string" && isInAppHref(detail.href)) handler(detail)
  }
  window.addEventListener(PLUGIN_NAVIGATION_REQUEST_EVENT, listener)
  return () => window.removeEventListener(PLUGIN_NAVIGATION_REQUEST_EVENT, listener)
}
