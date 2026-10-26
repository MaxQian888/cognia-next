/**
 * `ctx.uri` — URI/deep-link handler API (C2).
 *
 * A plugin registers a handler for deep-links addressed to its own id
 * (`cognia://plugin/<pluginId>/...`). Ownership is implicit: the registry keys
 * on the plugin id, so a plugin can only ever receive URLs targeting itself —
 * no extra permission is required. Like VS Code `window.registerUriHandler`.
 */

import { registerUriHandler, type UriHandler } from "@/lib/plugin/uri/uri-handler-registry"
import type { PluginUriAPI } from "@cognia/plugin-contract/lib/plugin/api/uri-api"
export type {
  PluginUriAPI,
  PluginUriHandlerDef,
} from "@cognia/plugin-contract/lib/plugin/api/uri-api"

export function createUriAPI(pluginId: string): PluginUriAPI {
  return {
    registerHandler(def) {
      const handler: UriHandler = (uri) => def.handle(uri)
      return registerUriHandler(pluginId, handler)
    },
  }
}
