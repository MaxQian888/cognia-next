// Route one plugin deep-link (C2): lazy-activate the plugin it addresses
// (`onUri:<id>`), then hand it to that plugin's handler. Shared by the desktop
// deep-link listener, the web `/deep-link` page and links a plugin opens itself.

import { parseDeepLink } from "./parse-deep-link"
import { dispatchUri, getUriHandler } from "./uri-handler-registry"

// One activation per plugin at a time: the router and the desktop shell's
// "is anyone handling this?" check see the same link at once.
const activations = new Map<string, Promise<void>>()

function activateForUri(pluginId: string): Promise<void> {
  let pending = activations.get(pluginId)
  if (!pending) {
    pending = (async () => {
      try {
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        await getPluginManager().handleActivationEvent(`onUri:${pluginId}`)
      } catch {
        // Manager not initialized — a statically-active plugin may still handle it.
      }
    })().finally(() => activations.delete(pluginId))
    activations.set(pluginId, pending)
  }
  return pending
}

/** True when the link reached a handler; false for a non-plugin link or no handler. */
export async function routePluginDeepLink(raw: string): Promise<boolean> {
  const parsed = parseDeepLink(raw)
  if (!parsed) return false
  await activateForUri(parsed.pluginId)
  return dispatchUri(parsed)
}

/**
 * True when a plugin link has a handler once the plugin it addresses is
 * activated. Does not dispatch: the desktop shell asks so it can report a link
 * to an uninstalled plugin, or one that registered no handler, as unknown.
 */
export async function hasPluginDeepLinkHandler(raw: string): Promise<boolean> {
  const parsed = parseDeepLink(raw)
  if (!parsed) return false
  await activateForUri(parsed.pluginId)
  return getUriHandler(parsed.pluginId) !== undefined
}
