/**
 * The preset catalog as the *app* sees it (ADR-0117).
 *
 * `preset-catalog.ts` deliberately stops at built-ins so it stays importable
 * from the CLI, and its docblock says the caller adds custom and plugin
 * presets. Nothing was that caller: the settings sheet and `resolveTurnComposition`
 * both called `builtInPresetCatalog()` directly, so a user who authored a custom
 * mode could not select it in the new picker, and an already-selected one did
 * not resolve at turn time either.
 *
 * This module is that caller. It lives outside `preset-catalog.ts` rather than
 * inside it because reaching into Zustand stores is exactly what that file must
 * not do.
 *
 * Deliberately a plain function, not only a hook: `resolveTurnComposition` and
 * `build-options.ts` are not React. Reading `getState()` from a non-React path
 * is the same shape `lib/claude/build-options.ts:resolveActiveAgentMode` has
 * used for these two stores all along. `hooks/agent/use-preset-catalog.ts`
 * wraps it for the UI, which needs to re-render when a mode is authored.
 */

import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { builtInPresetCatalog, presetFromAgentMode } from "./preset-catalog"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import type { AgentPresetDefinitionV1 } from "@cognia/agent-config-types/agent-composition"

export interface AppPresetCatalogInput {
  customModes: readonly AgentModeConfig[]
  pluginModes: readonly AgentModeConfig[]
}

/**
 * Merge the three sources into one ordered catalog. Pure — the stores are the
 * caller's problem, which is what makes this testable without a store harness.
 *
 * Order is built-in → custom → plugin, matching the lookup precedence in
 * `resolveActiveAgentMode`. A later source colliding with an earlier id is
 * **dropped, not merged**, for two reasons: the send path resolves the built-in
 * anyway (so a merged preset would describe a mode that never runs), and the
 * picker maps straight onto Radix `SelectItem` values, which must be unique.
 */
export function composeAppPresetCatalog(input: AppPresetCatalogInput): AgentPresetDefinitionV1[] {
  const catalog = builtInPresetCatalog()
  const seen = new Set(catalog.map((preset) => preset.id))

  for (const mode of input.customModes) {
    if (seen.has(mode.id)) continue
    seen.add(mode.id)
    catalog.push(presetFromAgentMode(mode, "custom"))
  }

  for (const mode of input.pluginModes) {
    if (seen.has(mode.id)) continue
    seen.add(mode.id)
    catalog.push(presetFromAgentMode(mode, "plugin"))
  }

  return catalog
}

/** Snapshot of the full catalog, for non-React callers. */
export function appPresetCatalog(): AgentPresetDefinitionV1[] {
  return composeAppPresetCatalog({
    customModes: Object.values(useCustomModeStore.getState().customModes),
    pluginModes: usePluginStore.getState().getAllModes(),
  })
}

/**
 * Every id the app can resolve.
 *
 * This is what `selectionFromLegacyModeId` must be given as its "known" set.
 * Handing it the built-in ids alone is what made every custom mode look like an
 * unrecognised legacy id and degrade to Standard.
 */
export function appPresetIds(): ReadonlySet<string> {
  return new Set(appPresetCatalog().map((preset) => preset.id))
}
