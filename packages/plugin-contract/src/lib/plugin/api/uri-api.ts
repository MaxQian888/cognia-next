/**
 * The plugin contract's share of `lib/plugin/api/uri-api.ts`, which re-exports these.
 */
import type { ParsedDeepLink } from "../uri/parse-deep-link"

export interface PluginUriHandlerDef {
  /** Optional id (for diagnostics). A plugin has at most one active handler. */
  id?: string
  handle: (uri: ParsedDeepLink) => void | Promise<void>
}

export interface PluginUriAPI {
  /** Register the handler for this plugin's deep-links. Returns a disposer. */
  registerHandler(def: PluginUriHandlerDef): () => void
}
