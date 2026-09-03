import { EXTERNAL_AGENT_PRESETS, getRunnablePresets } from "@/lib/ai/agent/external/presets"
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
  // A documented-only preset is not something a session can resume into.
  // `opencode-v2-preview` is the live case: it exists so the pinned legacy
  // contract is discoverable, and its own description says current OpenCode V2
  // builds are not compatible with it. The hand-written alias table this
  // replaced happened to omit it, and reading the ecosystem's runtimes without
  // this filter would have silently widened the claim.
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
