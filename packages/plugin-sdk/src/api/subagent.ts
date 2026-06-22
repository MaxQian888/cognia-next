/**
 * Plugin SDK — `subagent` capability surface (ADR-0032).
 *
 * Re-exports the `defineSubagent()` authoring helper and the dynamic
 * registry plugins use to contribute Claude SDK subagents at activation
 * time.
 *
 * Sources:
 *  - `packages/plugin-sdk/src/define/define-subagent.ts`
 *  - `lib/plugin/registries/subagent-registry.ts`
 *  - `types/plugin/plugin-subagent.ts`
 *
 * Plugin authors call `defineSubagent()` in their manifest builder for
 * autocomplete + compile-time shape checks, then declare the subagent in
 * the manifest's `subagents` array or call `registerSubagent()` from
 * inside `activate(ctx)`. The plugin manager unregisters everything the
 * plugin contributed on disable via `unregisterSubagentsByPlugin(pluginId)`.
 */

export { defineSubagent } from "../define/define-subagent"

export {
  registerSubagent,
  unregisterSubagentById,
  unregisterSubagentsByPlugin,
  getSubagent,
  getSubagentEntry,
  listSubagentIds,
  listSubagentEntries,
} from "@/lib/plugin/registries/subagent-registry"

export type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
