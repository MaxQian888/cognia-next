/**
 * cognia-rfc-toolkit — declarative skill-bundle plugin.
 *
 * All contributions (three local-bundle skills) are declared in plugin.json
 * and registered by the host's overlay dispatch, so this entry carries no
 * imperative registration. The manifest is imported rather than restated so
 * plugin.json stays the single source of truth.
 */

import type { PluginContext, PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import manifest from "../plugin.json"

const definition: PluginDefinition = {
  manifest: manifest as unknown as PluginManifest,

  activate: async (ctx: PluginContext) => {
    ctx.logger.info("cognia-rfc-toolkit activated")
  },

  deactivate: async (ctx?: PluginContext) => {
    ctx?.logger.info("cognia-rfc-toolkit deactivated")
  },
}

export default definition
