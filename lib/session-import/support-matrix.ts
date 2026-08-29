import { EXTERNAL_AGENT_PRESETS } from "@/lib/ai/agent/external/presets"

import { getSessionSources } from "./registry"

const SOURCE_PRESET_ALIASES: Readonly<Record<string, readonly string[]>> = {
  codex: ["codex", "codex-app-server"],
  cursor: ["cursor-cli"],
  opencode: ["opencode-acp", "opencode-server", "opencode-remote"],
  pi: ["pi-rpc"],
}

export interface ExternalSessionImportSupportRow {
  sourceId: string
  displayName: string
  verifiedVersion?: string
  verifiedAt?: string
  graphImport: boolean
  presetIds: string[]
  nativeResumeCandidate: boolean
  pickerOnly: boolean
}

/** Registry/preset-derived source of truth for docs and product support surfaces. */
export function buildExternalSessionSupportMatrix(): {
  importSources: ExternalSessionImportSupportRow[]
  runtimeOnlyPresetIds: string[]
} {
  const presetIds = Object.entries(EXTERNAL_AGENT_PRESETS)
    .filter(([, preset]) => preset !== null)
    .map(([id]) => id)
  const claimed = new Set<string>()
  const importSources = getSessionSources().map((source) => {
    const candidates = SOURCE_PRESET_ALIASES[source.id] ?? [source.id]
    const matching = candidates.filter((id) => presetIds.includes(id))
    matching.forEach((id) => claimed.add(id))
    return {
      sourceId: source.id,
      displayName: source.displayName,
      ...(source.verifiedVersion ? { verifiedVersion: source.verifiedVersion } : {}),
      ...(source.verifiedAt ? { verifiedAt: source.verifiedAt } : {}),
      graphImport: typeof source.parseGraph === "function",
      presetIds: matching,
      nativeResumeCandidate: matching.length > 0,
      pickerOnly: source.pickerOnly === true,
    }
  })
  return {
    importSources,
    runtimeOnlyPresetIds: presetIds.filter((id) => !claimed.has(id)),
  }
}
