/**
 * Ripgrep Tools — built-in plugin.
 *
 * Intentionally (almost) empty: the whole point of this plugin is that
 * `manifest.cliTools` declaratively wraps ripgrep as an agent tool with
 * ZERO imperative code. The manager materializes `ripgrep_search` from
 * the manifest at enable time and routes execution through the
 * `lib/plugin/cli-tools` safety pipeline (cli:execute consent, binary
 * detection, injection-proof argv templating, audit).
 *
 * Output shape: `rg --json` writes one JSON event per line, and the cliTools
 * contract has no newline-delimited-JSON parse mode (`outputParse` is
 * `text | json | lines`). `lines` is the closest fit, so the tool answers with
 * an array of strings, each one JSON-encoded event — a second encoding the
 * model has to undo per element. The tool description says so; a `jsonl`
 * parse mode in the SDK contract is what would remove it.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

// Spread plugin.json rather than re-declaring a subset. `builtinManifest()`
// merges module-over-JSON, so a hand-written subset silently WINS over the
// JSON for every key it names and drops `permissions` / `requires` /
// `cliTools` for every key it omits. Nothing needs adding on the TS side.
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: (ctx) => {
    ctx.logger.info("ripgrep-tools activated (cliTools are manifest-driven)")
  },
})
