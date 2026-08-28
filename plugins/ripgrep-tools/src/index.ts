/**
 * Ripgrep Tools — built-in plugin.
 *
 * Intentionally (almost) empty: the whole point of this plugin is that
 * `manifest.cliTools` declaratively wraps ripgrep as an agent tool with
 * ZERO imperative code. The manager materializes `ripgrep_search` from
 * the manifest at enable time and routes execution through the
 * `lib/plugin/cli-tools` safety pipeline (cli:execute consent, binary
 * detection, injection-proof argv templating, audit).
 */

import type { PluginContext, PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import manifest from "../plugin.json"

const definition: PluginDefinition = {
  // Spread plugin.json rather than re-declaring a subset. `builtinManifest()`
  // merges module-over-JSON (`{ ...base, ...rich }`), so a hand-written subset
  // silently WINS over the JSON for every key it names — and any key it omits
  // (here: `permissions`, `requires`, `cliTools`) only survives by luck. A
  // future edit adding `permissions` to the overlay would have dropped
  // `cli:execute` and broken the tool at the manifest.cliTools permission
  // check. There is nothing this plugin needs to add on the TS side.
  manifest: manifest as unknown as PluginManifest,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("ripgrep-tools activated (cliTools are manifest-driven)")
  },
}

export default definition
