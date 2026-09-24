import { EXTERNAL_AGENT_PRESETS, getRunnablePresets } from "@/lib/ai/agent/external/config/presets"
import { presetIdsForSessionSource } from "@/lib/agent-ecosystem/runtime-link"

import { getSessionSources } from "./registry"

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
  // Retired native protocols may still describe imported history, but cannot
  // be offered as execution targets for resuming that history.
  const runnable = new Set(getRunnablePresets())
  const claimed = new Set<string>()
  const importSources = getSessionSources().map((source) => {
    // Sources with no ecosystem row (a plugin-registered one, say) fall back to
    // their own id, which is how a plugin can name a preset it also ships.
    const candidates = presetIdsForSessionSource(source.id)
    const matching = (candidates.length > 0 ? candidates : [source.id]).filter(
      (id) => presetIds.includes(id) && runnable.has(id)
    )
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
