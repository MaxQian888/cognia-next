// Registry of plugin URI/deep-link handlers (C2). A plugin registers a handler
// for its own id via `ctx.uri.registerHandler`; the deep-link router parses an
// incoming `cognia://plugin/<id>/...` URL and calls `dispatchUri`, which routes
// to the owning plugin's handler. Ownership is enforced by keying on pluginId —
// a plugin only ever receives URLs addressed to its own id.

import type { ParsedDeepLink } from "./parse-deep-link"
import { loggers } from "@cognia/logging"

export type UriHandler = (uri: ParsedDeepLink) => void | Promise<void>

const handlers = new Map<string, UriHandler>()

/** Register the handler for a plugin. Re-registering replaces the previous. */
export function registerUriHandler(pluginId: string, handler: UriHandler): () => void {
  handlers.set(pluginId, handler)
  return () => {
    if (handlers.get(pluginId) === handler) handlers.delete(pluginId)
  }
}

export function getUriHandler(pluginId: string): UriHandler | undefined {
  return handlers.get(pluginId)
}

export function unregisterUriHandlersByPlugin(pluginId: string): number {
  return handlers.delete(pluginId) ? 1 : 0
}

/**
 * Dispatch a parsed deep-link to its owning plugin's handler. Returns true when
 * a handler was found and invoked. Handler errors are swallowed + logged so a
 * throwing plugin can't break the router.
 */
export function dispatchUri(parsed: ParsedDeepLink): boolean {
  const handler = handlers.get(parsed.pluginId)
  if (!handler) return false
  try {
    void Promise.resolve(handler(parsed)).catch((err) =>
      loggers.plugin.warn("uri handler rejected", { pluginId: parsed.pluginId, error: String(err) })
    )
  } catch (err) {
    loggers.plugin.warn("uri handler threw", { pluginId: parsed.pluginId, error: String(err) })
  }
  return true
}

export function __resetUriHandlersForTesting(): void {
  handlers.clear()
}
