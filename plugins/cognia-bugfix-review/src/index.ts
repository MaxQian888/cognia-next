/**
 * cognia-bugfix-review — declarative audit plugin.
 *
 * All contributions (the bugfix-review skill bundle and the bugfix-reviewer
 * subagent) are declared in plugin.json and registered by the host's overlay
 * dispatch, so this entry carries no imperative registration. The manifest is
 * imported rather than restated so plugin.json stays the single source of
 * truth.
 */

import type { PluginContext, PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import manifest from "../plugin.json"

const definition: PluginDefinition = {
  manifest: manifest as unknown as PluginManifest,

  activate: async (ctx: PluginContext) => {
    ctx.logger.info("cognia-bugfix-review activated")
  },

  deactivate: async (ctx?: PluginContext) => {
    ctx?.logger.info("cognia-bugfix-review deactivated")
  },
}

export default definition
