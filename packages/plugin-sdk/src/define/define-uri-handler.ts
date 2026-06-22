/**
 * Plugin SDK helper for URI/deep-link handlers (C2). Pure typesafety
 * pass-through for the object passed to `ctx.uri.registerHandler`.
 *
 * Usage:
 *   ctx.uri.registerHandler(defineUriHandler({
 *     handle: (uri) => {
 *       if (uri.path === "auth/callback") finishAuth(uri.query.code)
 *     },
 *   }))
 */

import type { PluginUriHandlerDef } from "@/lib/plugin/api/uri-api"

export function defineUriHandler(def: PluginUriHandlerDef): PluginUriHandlerDef {
  return def
}
