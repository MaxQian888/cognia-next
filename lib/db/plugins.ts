// Plugins table CRUD (Dexie v15 — §A-Schema, §E).
//
// Mirrors the shape of `lib/db/skills.ts`: flat module exporting list/get/
// create/update/delete + a few query helpers. The plugin manager treats
// this module as the single source of truth for installed plugin state;
// runtime contributions (tools, modes, presets, importers) flow through
// the existing extension points described in §A of the plan, not through
// this table.

import type { PluginRow } from "./plugin-types"
import { getDb } from "./schema"

/** Stable-prefix id generator matching the convention used by other CRUD modules. */
function newId() {
  return "plugin_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export async function listPlugins(): Promise<PluginRow[]> {
  return getDb().plugins.orderBy("name").toArray()
}

export async function listEnabledPlugins(): Promise<PluginRow[]> {
  // `enabled` is indexed; the in-memory filter matches the pattern used by
  // `listEnabledMcpServers` (Dexie's boolean indexing is unreliable across
  // browsers, so we filter post-fetch).
  return getDb()
    .plugins.filter((p) => p.enabled === true)
    .toArray()
}

export async function listPluginsByCapability(capability: string): Promise<PluginRow[]> {
  // Driven by the `*capabilities` multi-entry index — exactly the lookup the
  // Settings → Plugins capability filter uses.
  return getDb().plugins.where("capabilities").equals(capability).toArray()
}

export async function listPluginsBySource(source: PluginRow["source"]): Promise<PluginRow[]> {
  return getDb().plugins.where("source").equals(source).toArray()
}

export async function getPlugin(id: string): Promise<PluginRow | undefined> {
  return getDb().plugins.get(id)
}

/**
 * Fields a caller must provide. The rest (status default, capabilities default,
 * timestamps) are filled in here so the plugin manager's discover/install path
 * doesn't have to repeat the boilerplate.
 */
export type PluginDraft = Pick<
  PluginRow,
  "id" | "name" | "version" | "type" | "source" | "path" | "manifest"
> &
  Partial<
    Pick<
      PluginRow,
      | "status"
      | "enabled"
      | "lifecycle"
      | "capabilities"
      | "config"
      | "error"
      | "lastUsedAt"
      | "readme"
      | "licenseText"
      | "sourceUrl"
    >
  >

/**
 * Merge a draft over the persisted row. Pure — the write decision is made by
 * the callers below, which is what lets discovery skip a `put` entirely.
 */
function mergeDraft(draft: PluginDraft, existing: PluginRow | undefined, now: number): PluginRow {
  return {
    id: draft.id || newId(),
    name: draft.name.trim() || "Unnamed plugin",
    version: draft.version,
    status: draft.status ?? existing?.status ?? "discovered",
    source: draft.source,
    type: draft.type,
    enabled: draft.enabled ?? existing?.enabled ?? false,
    lifecycle: draft.lifecycle ?? existing?.lifecycle,
    capabilities: draft.capabilities ?? existing?.capabilities ?? [],
    path: draft.path,
    manifest: draft.manifest,
    config: draft.config ?? existing?.config,
    readme: draft.readme ?? existing?.readme,
    licenseText: draft.licenseText ?? existing?.licenseText,
    sourceUrl: draft.sourceUrl ?? existing?.sourceUrl,
    error: draft.error ?? existing?.error,
    lastUsedAt: draft.lastUsedAt ?? existing?.lastUsedAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

/**
 * True when the merged row would change nothing but `updatedAt`.
 *
 * Plugin discovery re-runs on EVERY launch and re-upserts every built-in, so
 * without this every boot wrote ~50 identical rows. Each write commits its own
 * Dexie transaction, each transaction wakes the `/plugins` live-query, and the
 * Library list therefore re-rendered (and, under `sort: "updated"`, re-ordered)
 * once per plugin while the panel was being read — the visible "list keeps
 * shuffling while loading". It also reset `updatedAt` on every launch, so the
 * detail pane's "Last updated" reported the last app start rather than the last
 * time the plugin actually changed.
 */
function isUnchanged(next: PluginRow, existing: PluginRow | undefined): boolean {
  if (!existing) return false
  const { updatedAt: _nextUpdatedAt, ...nextRest } = next
  const { updatedAt: _prevUpdatedAt, ...prevRest } = existing
  const a = stableStringify(nextRest)
  const b = stableStringify(prevRest)
  // A row this comparison cannot read is not a row it may call unchanged. This
  // is an optimization, so its failure mode has to be the write it was skipping.
  if (a === null || b === null) return false
  return a === b
}

/**
 * Key-order-independent JSON so a re-serialized manifest doesn't read as a
 * change, or null when the value cannot be serialized at all.
 *
 * IndexedDB stores by structured clone, which accepts cycles and BigInt, and
 * `JSON.stringify` throws on both. Every write that reaches here used to go
 * straight to `put` without being serialized, so letting the throw escape would
 * fail installs that used to succeed, over a comparison whose only job is to
 * skip work.
 */
function stableStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const record = val as Record<string, unknown>
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(record).sort()) sorted[key] = record[key]
        return sorted
      }
      return val as unknown
    })
  } catch {
    return null
  }
}

export async function upsertPlugin(draft: PluginDraft): Promise<PluginRow> {
  const now = Date.now()
  const existing = await getDb().plugins.get(draft.id)
  const row = mergeDraft(draft, existing, now)
  if (isUnchanged(row, existing)) return existing as PluginRow
  await getDb().plugins.put(row)
  return row
}

/**
 * Upsert a batch of drafts inside ONE Dexie transaction, skipping rows that
 * would not change (see `isUnchanged`).
 *
 * Discovery persists every plugin it finds. Doing that one `upsertPlugin` at a
 * time meant N transactions and therefore N live-query wake-ups, so on a cold
 * start the Library list grew (and re-sorted) row by row instead of appearing
 * at once. One transaction fires the observers once.
 */
export async function upsertPlugins(drafts: readonly PluginDraft[]): Promise<PluginRow[]> {
  if (drafts.length === 0) return []
  const now = Date.now()
  const db = getDb()
  return db.transaction("rw", db.plugins, async () => {
    const existingRows = await db.plugins.bulkGet(drafts.map((draft) => draft.id))
    const merged: PluginRow[] = []
    const changed: PluginRow[] = []
    drafts.forEach((draft, index) => {
      const existing = existingRows[index]
      const row = mergeDraft(draft, existing, now)
      if (isUnchanged(row, existing)) {
        merged.push(existing as PluginRow)
        return
      }
      merged.push(row)
      changed.push(row)
    })
    if (changed.length > 0) await db.plugins.bulkPut(changed)
    return merged
  })
}

export async function updatePlugin(
  id: string,
  patch: Partial<Omit<PluginRow, "id" | "createdAt">>
): Promise<void> {
  await getDb().plugins.update(id, { ...patch, updatedAt: Date.now() })
}

export async function compareAndSetPluginLifecycle(
  id: string,
  expectedRevision: number,
  lifecycle: NonNullable<PluginRow["lifecycle"]>
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.plugins, async () => {
    const row = await db.plugins.get(id)
    const currentRevision = row?.lifecycle?.revision ?? 0
    if (!row || currentRevision !== expectedRevision) return false
    await db.plugins.update(id, { lifecycle, updatedAt: Date.now() })
    return true
  })
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await updatePlugin(id, { enabled })
}

export async function setPluginStatus(id: string, status: PluginRow["status"]): Promise<void> {
  await updatePlugin(id, { status })
}

export async function setPluginError(id: string, error: string | undefined): Promise<void> {
  await updatePlugin(id, { error })
}

export async function setPluginConfig(id: string, config: Record<string, unknown>): Promise<void> {
  await updatePlugin(id, { config })
}

/** Host-level python runtime settings (python/hybrid plugins only). */
export async function getPythonHostSettings(
  id: string
): Promise<PluginRow["pythonHostSettings"] | undefined> {
  const row = await getPlugin(id)
  return row?.pythonHostSettings
}

export async function setPythonHostSettings(
  id: string,
  settings: PluginRow["pythonHostSettings"]
): Promise<void> {
  await updatePlugin(id, { pythonHostSettings: settings })
}

export async function recordPluginUsage(id: string): Promise<void> {
  await updatePlugin(id, { lastUsedAt: Date.now() })
}

export async function deletePlugin(id: string): Promise<void> {
  await getDb().plugins.delete(id)
}
