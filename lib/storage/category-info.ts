// Mapping from storage category → Dexie tables / display metadata. Keys here
// must match `lib/db/schema.ts` table names exactly; the storage-manager
// walks `db.tables` and routes each table through this map to bucket rows.
//
// Names that aren't in the map fall through to the `other` category so adding
// a new Dexie table won't make the breakdown panel under-report sizes —
// they'll just show up under "Other" until somebody updates this map.

import type { StorageCategory } from "./types"

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
    tables: ["settings"],
  },
  session: {
    i18nKey: "session",
    defaultName: "Sessions",
    tables: ["sessions"],
  },
  chat: {
    i18nKey: "chat",
    defaultName: "Messages",
    tables: ["messages", "sessionState"],
  },
  character: {
    i18nKey: "character",
    defaultName: "Characters",
    tables: ["characters"],
  },
  skill: {
    i18nKey: "skill",
    defaultName: "Skills",
    tables: ["skills", "skillResources"],
  },
  team: {
    i18nKey: "team",
    defaultName: "Teams",
    tables: ["teams"],
  },
  mcp: {
    i18nKey: "mcp",
    defaultName: "MCP servers",
    tables: ["mcpServers"],
  },
  preset: {
    i18nKey: "preset",
    defaultName: "Prompt presets",
    tables: ["promptPresets"],
  },
  canvas: {
    i18nKey: "canvas",
    defaultName: "Canvas documents",
    tables: ["canvasDocuments", "canvasVersions", "canvasComments", "canvasSessions"],
  },
  trustedWorkspace: {
    i18nKey: "trustedWorkspace",
    defaultName: "Trusted workspaces",
    tables: ["trustedWorkspaces"],
  },
  ttsKey: {
    i18nKey: "ttsKey",
    defaultName: "TTS keys",
    tables: ["tts_provider_keys"],
  },
  backupHistory: {
    i18nKey: "backupHistory",
    defaultName: "Backup history",
    tables: ["backupHistory"],
  },
  system: {
    i18nKey: "system",
    defaultName: "System",
    tables: [],
  },
  other: {
    i18nKey: "other",
    defaultName: "Other",
    tables: [],
  },
}

/** Reverse lookup: table name → category. */
export const TABLE_TO_CATEGORY: Record<string, StorageCategory> = (() => {
  const map: Record<string, StorageCategory> = {}
  for (const [key, value] of Object.entries(CATEGORY_INFO)) {
    for (const table of value.tables) {
      map[table] = key as StorageCategory
    }
  }
  return map
})()

export function categoryForTable(tableName: string): StorageCategory {
  return TABLE_TO_CATEGORY[tableName] ?? "other"
}

export function defaultDisplayName(category: StorageCategory): string {
  return CATEGORY_INFO[category].defaultName
}
