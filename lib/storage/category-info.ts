// Mapping from storage category → Dexie tables / display metadata. Keys here
// must match `lib/db/schema.ts` table names exactly; the storage-manager
// walks `db.tables` and routes each table through this map to bucket rows.
//
// The table list is derived from DataTableCatalog. An unknown dynamic table
// still falls through to `other`, while every static table is classified.

import type { StorageCategory } from "./types"
import {
  DATA_TABLE_CATALOG,
  policyForTable,
  tableNamesForCategory,
} from "@/lib/data-governance/table-catalog"

interface CategoryDescriptor {
  /** i18n key under `settings.data.breakdown.categories.<key>` for the label. */
  i18nKey: string
  /** Default display name when no translation is available. */
  defaultName: string
  /** Dexie table names that contribute rows to this category. */
  tables: readonly string[]
}

export const CATEGORY_INFO: Record<StorageCategory, CategoryDescriptor> = {
  settings: {
    i18nKey: "settings",
    defaultName: "Settings",
    tables: tableNamesForCategory("settings"),
  },
  pet: {
    i18nKey: "pet",
    defaultName: "Desktop pet",
    tables: tableNamesForCategory("pet"),
  },
  session: {
    i18nKey: "session",
    defaultName: "Sessions",
    tables: tableNamesForCategory("session"),
  },
  chat: {
    i18nKey: "chat",
    defaultName: "Messages",
    tables: tableNamesForCategory("chat"),
  },
  character: {
    i18nKey: "character",
    defaultName: "Characters",
    tables: tableNamesForCategory("character"),
  },
  skill: {
    i18nKey: "skill",
    defaultName: "Skills",
    tables: tableNamesForCategory("skill"),
  },
  team: {
    i18nKey: "team",
    defaultName: "Teams",
    tables: tableNamesForCategory("team"),
  },
  mcp: {
    i18nKey: "mcp",
    defaultName: "MCP servers",
    tables: tableNamesForCategory("mcp"),
  },
  preset: {
    i18nKey: "preset",
    defaultName: "Prompt presets",
    tables: tableNamesForCategory("preset"),
  },
  artifact: {
    i18nKey: "artifact",
    defaultName: "Artifacts",
    tables: tableNamesForCategory("artifact"),
  },
  canvas: {
    i18nKey: "canvas",
    defaultName: "Canvas documents",
    tables: tableNamesForCategory("canvas"),
  },
  trustedWorkspace: {
    i18nKey: "trustedWorkspace",
    defaultName: "Trusted workspaces",
    tables: tableNamesForCategory("trustedWorkspace"),
  },
  ttsKey: {
    i18nKey: "ttsKey",
    defaultName: "TTS keys",
    tables: tableNamesForCategory("ttsKey"),
  },
  backupHistory: {
    i18nKey: "backupHistory",
    defaultName: "Backup history",
    tables: tableNamesForCategory("backupHistory"),
  },
  vector: {
    i18nKey: "vector",
    defaultName: "Vector store",
    // Backed by the native sqlite-vec file at <app_data>/cognia/vectors.sqlite,
    // not by a Dexie table. Populated by storage-manager via Tauri only.
    tables: [],
  },
  system: {
    i18nKey: "system",
    defaultName: "System",
    tables: [],
  },
  other: {
    i18nKey: "other",
    defaultName: "Other",
    tables: tableNamesForCategory("other"),
  },
}

/** Reverse lookup: table name → category. */
export const TABLE_TO_CATEGORY: Record<string, StorageCategory> = (() => {
  const map: Record<string, StorageCategory> = {}
  for (const entry of DATA_TABLE_CATALOG) {
    map[entry.name] = entry.storageCategory
  }
  return map
})()

export function categoryForTable(tableName: string): StorageCategory {
  return policyForTable(tableName)?.storageCategory ?? "other"
}

/** Resolve the live table plan for a category. Unlike `CATEGORY_INFO.tables`,
 * this includes every governed table in `other` plus dynamic plugin tables. */
export function tablesForCategory(
  category: StorageCategory,
  runtimeTableNames?: readonly string[]
): string[] {
  return tableNamesForCategory(category, runtimeTableNames)
}

export function defaultDisplayName(category: StorageCategory): string {
  return CATEGORY_INFO[category].defaultName
}
