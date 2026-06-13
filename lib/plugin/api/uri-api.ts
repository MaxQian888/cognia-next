/**
 * `ctx.uri` — URI/deep-link handler API (C2).
 *
 * A plugin registers a handler for deep-links addressed to its own id
 * (`cognia://plugin/<pluginId>/...`). Ownership is implicit: the registry keys
 * on the plugin id, so a plugin can only ever receive URLs targeting itself —
 * no extra permission is required. Like VS Code `window.registerUriHandler`.
 */

import type { ParsedDeepLink } from "@/lib/plugin/uri/parse-deep-link"
import { registerUriHandler, type UriHandler } from "@/lib/plugin/uri/uri-handler-registry"

export interface PluginUriHandlerDef {
  /** Optional id (for diagnostics). A plugin has at most one active handler. */
  id?: string
  handle: (uri: ParsedDeepLink) => void | Promise<void>
}

export interface PluginUriAPI {
  /** Register the handler for this plugin's deep-links. Returns a disposer. */
  registerHandler(def: PluginUriHandlerDef): () => void
}

export function createUriAPI(pluginId: string): PluginUriAPI {
  return {
    registerHandler(def) {
      const handler: UriHandler = (uri) => def.handle(uri)
      return registerUriHandler(pluginId, handler)
    },
  }
}
