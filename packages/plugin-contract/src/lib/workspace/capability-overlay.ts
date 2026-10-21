export type WorkspaceCapabilityKind = (typeof WORKSPACE_CAPABILITY_KINDS)[number]

/**
 * Capability id → forced state in this workspace. An id that is absent
 * inherits the definition's global flag.
 */
export type WorkspaceCapabilityOverrides = Record<string, boolean>

export type WorkspaceCapabilityOverlay = Partial<
  Record<WorkspaceCapabilityKind, WorkspaceCapabilityOverrides>
>

export const WORKSPACE_CAPABILITY_KINDS = ["skill", "mcpServer", "template"] as const

export type WorkspaceCapabilityState = "inherit" | "on" | "off"

export const EMPTY_CAPABILITY_OVERLAY: WorkspaceCapabilityOverlay = Object.freeze({})

function overridesFor(
  overlay: WorkspaceCapabilityOverlay | null | undefined,
  kind: WorkspaceCapabilityKind
): WorkspaceCapabilityOverrides | undefined {
  const bucket = overlay?.[kind]
  // A hand-edited row (or a stale export) can carry anything here; a non-object
  // must read as "no opinion" rather than throwing inside a send path.
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return undefined
  return bucket
}

export function capabilityStateOf(
  overlay: WorkspaceCapabilityOverlay | null | undefined,
  kind: WorkspaceCapabilityKind,
  id: string
): WorkspaceCapabilityState {
  const value = overridesFor(overlay, kind)?.[id]
  if (value === true) return "on"
  if (value === false) return "off"
  return "inherit"
}

export function resolveCapabilityEnabled(
  globalEnabled: boolean,
  overlay: WorkspaceCapabilityOverlay | null | undefined,
  kind: WorkspaceCapabilityKind,
  id: string
): boolean {
  const state = capabilityStateOf(overlay, kind, id)
  if (state === "on") return true
  if (state === "off") return false
  return globalEnabled
}

export function applyCapabilityOverlay<T>(
  rows: readonly T[],
  kind: WorkspaceCapabilityKind,
  overlay: WorkspaceCapabilityOverlay | null | undefined,
  options: {
    idOf: (row: T) => string
    /** Required unless `alreadyFiltered` — the row's global flag. */
    enabledOf?: (row: T) => boolean
    alreadyFiltered?: boolean
  }
): T[] {
  const { idOf, enabledOf, alreadyFiltered = true } = options
  if (!alreadyFiltered && !enabledOf) {
    throw new Error("applyCapabilityOverlay: enabledOf is required unless alreadyFiltered")
  }
  const overrides = overridesFor(overlay, kind)
  if (!overrides) {
    return alreadyFiltered ? [...rows] : rows.filter((row) => enabledOf?.(row) === true)
  }
  return rows.filter((row) => {
    const globalEnabled = alreadyFiltered ? true : enabledOf!(row) === true
    return resolveCapabilityEnabled(globalEnabled, overlay, kind, idOf(row))
  })
}

export function withCapabilityState(
  overlay: WorkspaceCapabilityOverlay | null | undefined,
  kind: WorkspaceCapabilityKind,
  id: string,
  state: WorkspaceCapabilityState
): WorkspaceCapabilityOverlay {
  const next: WorkspaceCapabilityOverlay = {}
  for (const candidate of WORKSPACE_CAPABILITY_KINDS) {
    const bucket = overridesFor(overlay, candidate)
    if (bucket && Object.keys(bucket).length > 0) next[candidate] = { ...bucket }
  }
  const bucket = { ...(next[kind] ?? {}) }
  if (state === "inherit") delete bucket[id]
  else bucket[id] = state === "on"

  if (Object.keys(bucket).length > 0) next[kind] = bucket
  else delete next[kind]
  return next
}

export function countCapabilityOverrides(
  overlay: WorkspaceCapabilityOverlay | null | undefined,
  kind?: WorkspaceCapabilityKind
): number {
  const kinds = kind ? [kind] : WORKSPACE_CAPABILITY_KINDS
  let total = 0
  for (const candidate of kinds) {
    total += Object.keys(overridesFor(overlay, candidate) ?? {}).length
  }
  return total
}

export function pruneCapabilityOverlay(
  overlay: WorkspaceCapabilityOverlay | null | undefined,
  known: Partial<Record<WorkspaceCapabilityKind, Iterable<string>>>
): WorkspaceCapabilityOverlay {
  const next: WorkspaceCapabilityOverlay = {}
  for (const kind of WORKSPACE_CAPABILITY_KINDS) {
    const bucket = overridesFor(overlay, kind)
    if (!bucket) continue
    const ids = known[kind]
    // A kind the caller could not enumerate is left untouched: pruning against
    // an inventory we failed to load would silently discard the user's choices.
    if (!ids) {
      next[kind] = { ...bucket }
      continue
    }
    const alive = new Set(ids)
    const kept: WorkspaceCapabilityOverrides = {}
    for (const [id, value] of Object.entries(bucket)) {
      if (alive.has(id)) kept[id] = value
    }
    if (Object.keys(kept).length > 0) next[kind] = kept
  }
  return next
}
