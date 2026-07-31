/**
 * Plugin SDK — `uri-handler` capability surface.
 *
 * Re-exports the authoring helper and deep-link handler registry for
 * `cognia://plugin/<pluginId>/...` routes.
 */

export { defineUriHandler } from "../define/define-uri-handler"

export {
  registerUriHandler,
  getUriHandler,
  unregisterUriHandlersByPlugin,
  dispatchUri,
} from "@/lib/plugin/uri/uri-handler-registry"

export type { UriHandler } from "@/lib/plugin/uri/uri-handler-registry"
export type { ParsedDeepLink } from "@/lib/plugin/uri/parse-deep-link"
export type { PluginUriHandlerDef } from "@/lib/plugin/api/uri-api"
