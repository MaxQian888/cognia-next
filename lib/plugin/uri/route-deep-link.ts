// Route one plugin deep-link (C2): lazy-activate the plugin it addresses
// (`onUri:<id>`), then hand it to that plugin's handler. Shared by the desktop
// deep-link listener, the web `/deep-link` page and links a plugin opens itself.

import { parseDeepLink } from "./parse-deep-link"
import { dispatchUri } from "./uri-handler-registry"

/** True when the link reached a handler; false for a non-plugin link or no handler. */
export async function routePluginDeepLink(raw: string): Promise<boolean> {
  const parsed = parseDeepLink(raw)
  if (!parsed) return false
  try {
    const { getPluginManager } = await import("@/lib/plugin/core/manager")
    await getPluginManager().handleActivationEvent(`onUri:${parsed.pluginId}`)
  } catch {
    // Manager not initialized — a statically-active plugin may still handle it.
  }
  return dispatchUri(parsed)
}
