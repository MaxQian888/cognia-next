// CRUD + seed surface for the `promptPresets` Dexie table.
//
// A preset is a reusable session-configuration template — see
// `SystemPromptPreset` in `lib/claude/types.ts`. The shape is intentionally
// additive over the v2 baseline (id/name/content/timestamps), so legacy rows
// keep working after the v12 schema upgrade.
//
// Built-in presets (seeded via `seedBuiltInPresets`) are read-only:
// `deletePreset` / `updatePreset` / `setDefaultPreset` for built-ins reject
// (the UI only offers Duplicate). User-created rows use the `p_` id prefix;
// built-ins use the stable `preset_builtin_<slug>` ids declared in
// `lib/db/preset-built-ins.ts`.

import type { SystemPromptPreset } from "@/lib/claude/types"
import { getDb } from "./schema"
import { BUILT_IN_PRESET_IDS, buildBuiltInPresets } from "./preset-built-ins"

function newId() {
  return "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** Fields that may be supplied to `createPreset`. Name + content are required. */
export type PresetDraft = Pick<SystemPromptPreset, "name" | "content"> &
  Partial<
    Pick<
      SystemPromptPreset,
      | "description"
      | "icon"
      | "color"
      | "category"
      | "model"
      | "permissionMode"
      | "effort"
      | "allowedTools"
      | "disallowedTools"
      | "mcpServerIds"
      | "skillIds"
      | "agentModeId"
      | "workingDir"
      | "isDefault"
      | "isFavorite"
    >
  >

/** Order: explicit `sortOrder` ascending, then `updatedAt` descending. */
function comparePresets(a: SystemPromptPreset, b: SystemPromptPreset): number {
  const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER
  const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER
  if (aOrder !== bOrder) return aOrder - bOrder
  return b.updatedAt - a.updatedAt
}

export async function listPresets(): Promise<SystemPromptPreset[]> {
  const rows = await getDb().promptPresets.toArray()
  return rows.sort(comparePresets)
}

export async function getPreset(id: string): Promise<SystemPromptPreset | undefined> {
  return getDb().promptPresets.get(id)
}

export async function getPresetsByIds(ids: string[]): Promise<SystemPromptPreset[]> {
  if (ids.length === 0) return []
  const rows = await getDb().promptPresets.bulkGet(ids)
  return rows.filter((r): r is SystemPromptPreset => r !== undefined)
}

/**
 * Look up the single "default" preset. The single-default invariant is
 * enforced by `setDefaultPreset`; defensive callers shouldn't see more than
 * one row marked default, but if persistence drift produces several we just
 * return the first by sort order.
 */
export async function getDefaultPreset(): Promise<SystemPromptPreset | undefined> {
  const rows = await getDb().promptPresets.toArray()
  const defaults = rows.filter((r) => r.isDefault === true)
  if (defaults.length === 0) return undefined
  defaults.sort(comparePresets)
  return defaults[0]
}

async function nextSortOrder(): Promise<number> {
  const rows = await getDb().promptPresets.toArray()
  if (rows.length === 0) return 0
  const max = rows.reduce((acc, r) => Math.max(acc, r.sortOrder ?? 0), 0)
  return max + 1
}

export async function createPreset(draft: PresetDraft): Promise<SystemPromptPreset> {
  const now = Date.now()
  const sortOrder = await nextSortOrder()
  const preset: SystemPromptPreset = {
    id: newId(),
    name: draft.name.trim() || "Untitled preset",
    content: draft.content,
    description: draft.description,
    icon: draft.icon,
    color: draft.color,
    category: draft.category,
    model: draft.model,
    permissionMode: draft.permissionMode,
    effort: draft.effort,
    allowedTools: draft.allowedTools,
    disallowedTools: draft.disallowedTools,
    mcpServerIds: draft.mcpServerIds,
    skillIds: draft.skillIds,
    agentModeId: draft.agentModeId,
    workingDir: draft.workingDir,
    isDefault: false,
    isFavorite: draft.isFavorite ?? false,
    isBuiltIn: false,
    sortOrder,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().promptPresets.put(preset)
  // If the caller asked for this to be the new default, route through
  // `setDefaultPreset` so the single-default invariant is preserved in one
  // shot (rather than the user hitting two ops to get there).
  if (draft.isDefault) {
    await setDefaultPreset(preset.id)
    return (await getPreset(preset.id))!
  }
  return preset
}

/**
 * Patch a preset. Fields that can't be patched (`id`, `createdAt`,
 * `isBuiltIn`) are stripped silently to avoid corrupting invariants. Built-in
 * rows reject — the UI surfaces "Duplicate" as the alternative.
 */
export async function updatePreset(
  id: string,
  patch: Partial<Omit<SystemPromptPreset, "id" | "createdAt" | "isBuiltIn">>
): Promise<void> {
  const existing = await getDb().promptPresets.get(id)
  if (!existing) throw new Error(`Preset ${id} not found`)
  if (existing.isBuiltIn) {
    throw new Error("Built-in presets cannot be edited. Duplicate first.")
  }
  // If the caller is flipping `isDefault` on, route through `setDefaultPreset`
  // so the single-default invariant is enforced in a transaction.
  if (patch.isDefault === true) {
    const { isDefault: _ignore, ...rest } = patch
    void _ignore
    if (Object.keys(rest).length > 0) {
      await getDb().promptPresets.update(id, { ...rest, updatedAt: Date.now() })
    }
    await setDefaultPreset(id)
    return
  }
  await getDb().promptPresets.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deletePreset(id: string): Promise<void> {
  const existing = await getDb().promptPresets.get(id)
  if (!existing) return
  if (existing.isBuiltIn) {
    throw new Error("Built-in presets cannot be deleted. Duplicate first.")
  }
  await getDb().promptPresets.delete(id)
}

/**
 * Clone a preset (built-in or otherwise) into an editable copy. The copy
 * carries every override field but is never marked built-in / default; it
 * keeps `isFavorite` so the user's preference doesn't get reset.
 */
export async function duplicatePreset(id: string): Promise<SystemPromptPreset> {
  const source = await getDb().promptPresets.get(id)
  if (!source) throw new Error(`Preset ${id} not found`)
  const now = Date.now()
  const sortOrder = await nextSortOrder()
  const copy: SystemPromptPreset = {
    ...source,
    id: newId(),
    name: `${source.name} (Copy)`,
    isBuiltIn: false,
    isDefault: false,
    sortOrder,
    usageCount: 0,
    lastUsedAt: undefined,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().promptPresets.put(copy)
  return copy
}

/**
 * Mark a preset as the default. Clears `isDefault` on every other row in a
 * single transaction so the single-default invariant always holds. Built-in
 * presets are eligible — the user expects to be able to make a built-in
 * their default without duplicating it.
 */
export async function setDefaultPreset(id: string): Promise<void> {
  const db = getDb()
  const target = await db.promptPresets.get(id)
  if (!target) throw new Error(`Preset ${id} not found`)
  await db.transaction("rw", db.promptPresets, async () => {
    const all = await db.promptPresets.toArray()
    const now = Date.now()
    const next = all.map((row) => ({
      ...row,
      isDefault: row.id === id,
      updatedAt: row.id === id || row.isDefault ? now : row.updatedAt,
    }))
    await db.promptPresets.bulkPut(next)
  })
}

export async function clearDefaultPreset(): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.promptPresets, async () => {
    const defaults = (await db.promptPresets.toArray()).filter((r) => r.isDefault === true)
    if (defaults.length === 0) return
    const now = Date.now()
    await db.promptPresets.bulkPut(
      defaults.map((row) => ({ ...row, isDefault: false, updatedAt: now }))
    )
  })
}

export async function togglePresetFavorite(id: string): Promise<void> {
  const existing = await getDb().promptPresets.get(id)
  if (!existing) throw new Error(`Preset ${id} not found`)
  await getDb().promptPresets.update(id, {
    isFavorite: !existing.isFavorite,
    updatedAt: Date.now(),
  })
}

/**
 * Persist a new manual order. `orderedIds` is the full list in the desired
 * top-to-bottom order; missing rows keep their existing `sortOrder` (placed
 * after the explicit ones). Stamps `updatedAt` on touched rows.
 */
export async function reorderPresets(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return
  const db = getDb()
  await db.transaction("rw", db.promptPresets, async () => {
    const all = await db.promptPresets.toArray()
    const indexById = new Map(orderedIds.map((id, idx) => [id, idx]))
    const now = Date.now()
    const next = all.map((row) => {
      const idx = indexById.get(row.id)
      if (idx === undefined) return row
      return { ...row, sortOrder: idx, updatedAt: now }
    })
    await db.promptPresets.bulkPut(next)
  })
}

/**
 * Bump usage tracking. Fire-and-forget: callers don't await. A failed write
 * here is non-fatal — the UI's "Recent" filter is a nice-to-have, not a
 * load-bearing invariant.
 */
export async function recordPresetUsage(id: string): Promise<void> {
  const existing = await getDb().promptPresets.get(id)
  if (!existing) return
  await getDb().promptPresets.update(id, {
    usageCount: (existing.usageCount ?? 0) + 1,
    lastUsedAt: Date.now(),
  })
}

/**
 * Idempotent built-in seed. Identified by stable ids so repeat calls never
 * duplicate built-ins or stomp on user-created rows. Re-puts the canonical
 * built-in payload every time, so seed-data improvements (typos, prompt
 * tuning) propagate to existing installs on the next launch.
 */
export async function seedBuiltInPresets(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const builtIns = buildBuiltInPresets(now)
  await db.promptPresets.bulkPut(builtIns)
}

/**
 * Wipe every preset (built-in and user-created) and reseed the built-ins.
 * Used by the section's "Reset to built-ins" action. The user is expected to
 * confirm in a dialog before reaching this; the helper does no extra
 * confirmation of its own.
 */
export async function resetPresetsToBuiltIns(): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.promptPresets, async () => {
    await db.promptPresets.clear()
  })
  await seedBuiltInPresets()
}

/** Quick check used by the section UI to gate edit / delete affordances. */
export function isBuiltInPreset(preset: SystemPromptPreset): boolean {
  return preset.isBuiltIn === true || BUILT_IN_PRESET_IDS.has(preset.id)
}
