/**
 * The preset axis (ADR-0117).
 *
 * Four presets are new. Everything else in the picker is an *adaptation* of a
 * mode that already exists — a built-in domain mode, a user's custom mode, or a
 * plugin-contributed one — so this module adds no second registry: it projects
 * `AgentModeConfig` into `AgentPresetDefinitionV1` and leaves ownership of the
 * mode records where it is.
 *
 * `general`, `plan`, `build` and `workflow` are deliberately NOT adapted. They
 * were never personas: they are Standard with a different authority or
 * orchestration, and `lib/agent/composition/legacy-mode-mapping.ts` maps them
 * onto axis values instead of minting four near-identical presets.
 */

import { BUILT_IN_AGENT_MODES } from "@/types/agent/agent-mode"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import type {
  AgentPresetDefinitionV1,
  AgentPresetSource,
} from "@cognia/agent-config-types/agent-composition"

export const STANDARD_PRESET_ID = "standard"
export const MINIMAL_PRESET_ID = "minimal"
export const CODE_PRESET_ID = "code"
export const CREATOR_PRESET_ID = "creator"

/**
 * Legacy mode ids that become axis values rather than presets.
 *
 * Exported so the migration and the catalog cannot disagree about which ids are
 * "not a persona" — a disagreement would either duplicate Standard in the
 * picker or drop a legacy id on the floor.
 */
export const AXIS_ONLY_LEGACY_MODE_IDS: readonly string[] = ["general", "plan", "build", "workflow"]

/**
 * Read-only SDK core tools Minimal is allowed to offer.
 *
 * Pinned to real names from `lib/skills/recording/tool-catalog.ts`; an invented
 * name would make the preset silently inert rather than restrictive.
 */
export const MINIMAL_TOOL_SET: readonly string[] = ["Read", "Glob", "Grep"]

/**
 * Version stamped on the built-in presets.
 *
 * Intentionally a constant rather than something derived: `compositionDigest`
 * already covers `promptDigest` and `toolDigest`, so forgetting to bump this
 * cannot hide a prompt or tool change from replay diffing. It exists to let a
 * preset be *deliberately* invalidated.
 */
const BUILT_IN_PRESET_VERSION = "1"

export const STANDARD_PRESET: AgentPresetDefinitionV1 = {
  id: STANDARD_PRESET_ID,
  source: "builtin",
  version: BUILT_IN_PRESET_VERSION,
  name: "Standard",
  description: "General purpose assistant with the host's default tools.",
  icon: "Bot",
  recommends: { authority: "default", toolPresentation: "native", orchestration: "direct" },
  outputFormat: "text",
  previewEnabled: false,
  legacyModeId: "general",
}

export const MINIMAL_PRESET: AgentPresetDefinitionV1 = {
  id: MINIMAL_PRESET_ID,
  source: "builtin",
  version: BUILT_IN_PRESET_VERSION,
  name: "Minimal",
  description: "Deterministic read-only tools only — inspect without changing anything.",
  icon: "Eye",
  defaultToolSet: [...MINIMAL_TOOL_SET],
  recommends: { authority: "plan", toolPresentation: "native", orchestration: "direct" },
  // Pinned, not merely recommended: a selection or a legacy migration must not
  // be able to turn the read-only preset into an editing one.
  maxAuthority: "plan",
  outputFormat: "markdown",
  previewEnabled: false,
}

export const CODE_PRESET: AgentPresetDefinitionV1 = {
  id: CODE_PRESET_ID,
  source: "builtin",
  version: BUILT_IN_PRESET_VERSION,
  name: "Code",
  description: "Compose tool calls as code in a sandbox. Read-only in this release.",
  icon: "Code2",
  recommends: { authority: "default", toolPresentation: "code", orchestration: "direct" },
  // The code SDK reaches read-only tools only, so nothing here can consume a
  // write permission. Capping at `default` keeps an escalated selection from
  // implying an editing capability that does not exist.
  maxAuthority: "default",
  experimental: true,
  outputFormat: "markdown",
  previewEnabled: false,
}

export const CREATOR_PRESET: AgentPresetDefinitionV1 = {
  id: CREATOR_PRESET_ID,
  source: "builtin",
  version: BUILT_IN_PRESET_VERSION,
  name: "Creator",
  description: "Author plugins, skills, hooks, presets and workflows in an authoring root.",
  icon: "Wand2",
  recommends: { authority: "acceptEdits", toolPresentation: "native", orchestration: "workflow" },
  // Creator writes files. It must never reach `bypassPermissions`: every
  // permission widening, install, signature and publish is a separate approval.
  maxAuthority: "acceptEdits",
  visibility: "developer-only",
  outputFormat: "markdown",
  previewEnabled: false,
}

/** The four presets this decision introduces, in picker order. */
export const NEW_BUILT_IN_PRESETS: readonly AgentPresetDefinitionV1[] = [
  STANDARD_PRESET,
  MINIMAL_PRESET,
  CODE_PRESET,
  CREATOR_PRESET,
]

/**
 * Project an existing mode record into a preset.
 *
 * Lossless for everything the composition layer consumes; the mode record stays
 * the owner of its prompt and tools. `permissionMode` becomes a *recommendation*
 * rather than a cap, because a domain mode's permission was only ever a default
 * and the user's authority axis is allowed to differ from it.
 */
export function presetFromAgentMode(
  mode: AgentModeConfig,
  source: AgentPresetSource
): AgentPresetDefinitionV1 {
  const recommendedAuthority =
    mode.permissionMode === "plan" ||
    mode.permissionMode === "default" ||
    mode.permissionMode === "acceptEdits" ||
    mode.permissionMode === "bypassPermissions"
      ? mode.permissionMode
      : undefined

  return {
    id: mode.id,
    source,
    version: BUILT_IN_PRESET_VERSION,
    name: mode.name,
    description: mode.description,
    icon: mode.icon,
    systemPromptDelta: mode.systemPrompt,
    defaultToolSet: mode.tools ? [...mode.tools] : undefined,
    recommends: {
      authority: recommendedAuthority,
      toolPresentation: "native",
      orchestration: "direct",
    },
    outputFormat: mode.outputFormat,
    previewEnabled: mode.previewEnabled,
    legacyModeId: mode.id,
  }
}

/** Built-in domain modes, minus the four that are axis values rather than personas. */
export function builtInDomainPresets(): AgentPresetDefinitionV1[] {
  return BUILT_IN_AGENT_MODES.filter((mode) => !AXIS_ONLY_LEGACY_MODE_IDS.includes(mode.id)).map(
    (mode) => presetFromAgentMode(mode, "builtin")
  )
}

/**
 * Everything selectable from built-in sources.
 *
 * Custom and plugin presets are added by the caller, which owns those stores;
 * this module never reaches into them so it stays usable from the CLI.
 */
export function builtInPresetCatalog(): AgentPresetDefinitionV1[] {
  return [...NEW_BUILT_IN_PRESETS, ...builtInDomainPresets()]
}

/** Presets a picker may offer, given whether developer mode is on. */
export function visiblePresets(
  presets: readonly AgentPresetDefinitionV1[],
  options: { developerMode: boolean; includeExperimental?: boolean }
): AgentPresetDefinitionV1[] {
  return presets.filter((preset) => {
    if (preset.visibility === "developer-only" && !options.developerMode) return false
    if (preset.experimental && !options.includeExperimental) return false
    return true
  })
}
