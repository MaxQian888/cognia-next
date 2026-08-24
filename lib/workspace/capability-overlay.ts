/**
 * Per-workspace enablement for globally-defined capabilities.
 *
 * # The shape of the problem
 *
 * Skills and MCP servers are defined once, machine-wide, and carry a single
 * boolean: `skills.status` and `mcpServers.enabled`. That is the right home for
 * the definition — a skill is a skill wherever you are — but it is the wrong
 * granularity for *use*. A Jira MCP server belongs to the work repo and has no
 * business injecting tools into a hobby project; a house-style skill for one
 * codebase becomes noise in the next. Today the only way to express that is to
 * toggle the global flag on every workspace switch, by hand, and remember to
 * put it back.
 *
 * # Why an overlay rather than a `projectId` column
 *
 * Giving definitions a workspace foreign key would make them *belong* to a
 * workspace, which is a different and worse model: the same MCP server would
 * have to be re-registered (and re-authorised) per workspace, and a definition
 * would vanish from the library when its workspace was deleted. So the
 * definition tables are untouched. The workspace stores only the deltas, on its
 * own row — like `terminalConfig` and `knowledgeSettings` already do.
 *
 * # One mechanism, three states
 *
 * The overlay maps capability id → `true` (on here) / `false` (off here).
 * An id that is absent inherits the global flag. That is deliberately ONE
 * mechanism rather than the "allowlist plus overrides" pair sketched during
 * design: an allowlist and a per-id override answer the same question, and two
 * ways to say "this is on" is how surfaces start disagreeing with each other.
 * The allowlist is a projection — `resolveEnabledIds` — not a second store.
 *
 * It also matches what mature editors do: VS Code's "Disable (Workspace)" is a
 * per-extension delta on top of a global state, not a workspace manifest.
 *
 * # Why plugins are not here
 *
 * `plugins.enabled` is not a preference — it is the runtime's loaded state,
 * written by `manager.setPluginIntent` as a *consequence* of activation
 * (`lib/plugin/core/toggle-plugin-enabled.ts`). Overlaying it per workspace
 * would mean switching workspaces rewrites the column that records what is
 * actually running, destroying the global baseline it also serves as. Doing it
 * properly needs a second column separating "installed and enabled by default"
 * from "loaded right now" — a definition-table change this layer exists to
 * avoid. Plugins therefore stay workspace-wide, and the Capabilities tab says
 * so rather than leaving the user to infer it.
 */

/** Capability families a workspace may re-scope. See the note on plugins above. */
export const WORKSPACE_CAPABILITY_KINDS = ["skill", "mcpServer"] as const

export type WorkspaceCapabilityKind = (typeof WORKSPACE_CAPABILITY_KINDS)[number]

/**
 * Capability id → forced state in this workspace. An id that is absent
 * inherits the definition's global flag.
 */
export type WorkspaceCapabilityOverrides = Record<string, boolean>

export type WorkspaceCapabilityOverlay = Partial<
  Record<WorkspaceCapabilityKind, WorkspaceCapabilityOverrides>
>

/** What the workspace says about one capability, as the UI presents it. */
export type WorkspaceCapabilityState = "inherit" | "on" | "off"

/** Nothing overridden — the shared value for "this workspace has no opinions". */
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

/** The workspace's stated position on one capability. */
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

/** Whether a capability is live in this workspace, given its global flag. */
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

/**
 * Filter rows already known to be globally enabled down to this workspace.
 *
 * Callers that pre-filter on the global flag (`listEnabledMcpServers`) lose the
 * disabled rows before we see them, so a `"on"` override could never resurrect
 * one. `alreadyFiltered` says which contract the caller is using: pass `false`
 * with the full table to let an override turn something back on.
 */
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

/** The ids live in this workspace — the "enabled set" as a projection. */
export function resolveEnabledCapabilityIds<T>(
  rows: readonly T[],
  kind: WorkspaceCapabilityKind,
  overlay: WorkspaceCapabilityOverlay | null | undefined,
  options: { idOf: (row: T) => string; enabledOf: (row: T) => boolean }
): string[] {
  return applyCapabilityOverlay(rows, kind, overlay, { ...options, alreadyFiltered: false }).map(
    options.idOf
  )
}

/**
 * A new overlay with one capability set to `state`.
 *
 * `"inherit"` deletes the entry rather than storing a tombstone, and an empty
 * bucket is dropped, so a workspace that has been toggled back and forth
 * persists as `{}` and not as a pile of no-ops. That matters because the
 * override count is what the UI uses to say "this workspace differs".
 */
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

/** How many capabilities this workspace overrides — `kind` narrows the count. */
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

/**
 * Drop overrides whose capability no longer exists.
 *
 * A deleted skill would otherwise leave its id in every workspace that had an
 * opinion about it, so the "3 overrides" badge would keep counting a row that
 * cannot be shown or cleared. Called when the Capabilities tab loads the real
 * inventory — the only place that knows what still exists.
 */
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
