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
      | "capabilities"
      | "config"
      | "error"
      | "lastUsedAt"
      | "readme"
      | "licenseText"
      | "sourceUrl"
    >
  >

export async function upsertPlugin(draft: PluginDraft): Promise<PluginRow> {
  const now = Date.now()
  const existing = await getDb().plugins.get(draft.id)
  const row: PluginRow = {
    id: draft.id || newId(),
    name: draft.name.trim() || "Unnamed plugin",
    version: draft.version,
    status: draft.status ?? existing?.status ?? "discovered",
    source: draft.source,
    type: draft.type,
    enabled: draft.enabled ?? existing?.enabled ?? false,
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
  await getDb().plugins.put(row)
  return row
}

export async function updatePlugin(
  id: string,
  patch: Partial<Omit<PluginRow, "id" | "createdAt">>
): Promise<void> {
  await getDb().plugins.update(id, { ...patch, updatedAt: Date.now() })
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
