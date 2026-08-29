// Per-domain export/import. Each domain serializes a single Dexie table to
// a small JSON file the user can email/upload/share without exposing their
// entire backup. Import merges by id under the user's chosen strategy
// (skip / overwrite / duplicate), respecting built-ins.

import type {
  Character,
  McpServer,
  Skill,
  SkillResource,
  SystemPromptPreset,
  Team,
} from "@cognia/agent-config-types"
import type { PluginAnalyticsRow, PluginPermissionRow, PluginRow } from "@/lib/db/plugin-types"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { listAllCanvasCommentRows } from "@/lib/db/context-comments"
import { applyBackupPackage } from "@/lib/data/apply-package"
import {
  EXPORT_SCHEMA_VERSION,
  type BackupPackageV3,
  type BackupPayloadV3,
  type ImportMergeStrategy,
  type ImportSummary,
} from "@/lib/data/types"
import { sha256Hex } from "@/lib/data/crypto"
import { canonicalStringify } from "@/lib/data/migrate"
import { browserSnapshotStorage, DOMAIN_SNAPSHOT_MODULES } from "@/lib/data/snapshots/registry"
import type { LocalStorageSnapshot, SnapshotEnv, SnapshotModule } from "@/lib/data/snapshots/types"

export type DomainKey =
  | "skills"
  | "mcpServers"
  | "promptPresets"
  | "characters"
  | "teams"
  | "settingsTheme"
  | "canvas"
  | "a2ui"
  | "externalAgents"
  | "customModes"
  | "agentTeamsLayout"
  | "agentRuntime"
  | "customThemes"
  | "artifacts"
  | "a2uiSurfaces"
  | "canvasKeybindings"
  | "canvasComments"
  | "canvasSettings"
  | "schedulerPrefs"
  | "plugins"

export interface DomainExportFile {
  version: "cognia-domain-1.0"
  domain: DomainKey
  exportedAt: string
  appVersion: string
  payload: BackupPayloadV3
}

export interface DomainSpec {
  key: DomainKey
  /** UI label key under `settings.data.domain.<key>.title`. */
  labelKey: string
  /**
   * Human-readable label for plugin-contributed specs. Builtins leave this
   * unset and are translated via `labelKey`; a plugin has no entry in the
   * app's message catalog, so without this its row would render the raw key
   * path. The UI prefers `displayName` when present.
   */
  displayName?: string
  /** Read the rows currently in Dexie. Returns the v3 payload subset. */
  read: () => Promise<BackupPayloadV3>
  /** Default merge strategy applied when the user hasn't picked one. */
  defaultStrategy: ImportMergeStrategy
}

const APP_VERSION = "0.1.0"

function makeSpec(
  key: DomainKey,
  labelKey: string,
  read: () => Promise<BackupPayloadV3>,
  defaultStrategy: ImportMergeStrategy = "skip"
): DomainSpec {
  return { key, labelKey, read, defaultStrategy }
}

/** Wrap a {@link SnapshotModule} as a domain spec. The exported file
 * carries a single-key `localStorageSnapshots` map so the rest of the
 * pipeline (apply / import) reuses the existing v3 path. */
function makeSnapshotSpec(
  key: DomainKey,
  labelKey: string,
  module: SnapshotModule,
  defaultStrategy: ImportMergeStrategy = "overwrite"
): DomainSpec {
  return makeSpec(
    key,
    labelKey,
    async () => {
      const storage = browserSnapshotStorage()
      if (!storage) return {}
      const env: SnapshotEnv = { storage }
      const snap = module.read(env)
      if (!snap) return {}
      const localStorageSnapshots: Record<string, LocalStorageSnapshot> = {
        [module.key]: snap,
      }
      return { localStorageSnapshots }
    },
    defaultStrategy
  )
}

const SNAPSHOT_DOMAIN_KEYS: Record<string, DomainKey> = {
  "cognia-external-agents": "externalAgents",
  "cognia-custom-modes": "customModes",
  "cognia-agent-teams": "agentTeamsLayout",
  "cognia-next.agent-runtime": "agentRuntime",
  "cognia-custom-themes": "customThemes",
  "cognia-a2ui-surfaces": "a2uiSurfaces",
  "cognia-canvas-keybindings": "canvasKeybindings",
  "cognia-canvas-comments": "canvasComments",
  "cognia-canvas-settings": "canvasSettings",
  "cognia-scheduler": "schedulerPrefs",
}

export const DOMAIN_TRANSFERS: DomainSpec[] = [
  makeSpec("skills", "skills", async () => {
    const db = getDb()
    // IndexedDB doesn't reliably index booleans; filter in memory.
    const allSkills = (await db.skills.toArray()) as Skill[]
    const userSkills = allSkills.filter((s) => !s.isBuiltIn)
    const userIds = userSkills.map((s) => s.id)
    const allResources = (await db.skillResources.toArray()) as SkillResource[]
    const resources = allResources.filter((r) => userIds.includes(r.skillId))
    return { skills: userSkills, skillResources: resources }
  }),
  makeSpec("mcpServers", "mcp", async () => {
    const db = getDb()
    return { mcpServers: (await db.mcpServers.toArray()) as McpServer[] }
  }),
  makeSpec("promptPresets", "presets", async () => {
    const db = getDb()
    // Only carry user-created rows. Built-ins are re-seeded locally on
    // every launch via `seedBuiltInPresets`, so shipping them in an export
    // would bloat the file and risk overwriting locally-tuned seed copy
    // when the import lands.
    const all = (await db.promptPresets.toArray()) as SystemPromptPreset[]
    return {
      promptPresets: all.filter((p) => p.isBuiltIn !== true),
    }
  }),
  makeSpec("characters", "characters", async () => {
    const db = getDb()
    const characters = await db.characters.toArray()
    return { characters: characters.filter((c: Character) => !c.isBuiltIn) }
  }),
  makeSpec("teams", "teams", async () => {
    const db = getDb()
    const teams = await db.teams.toArray()
    return { teams: teams.filter((t: Team) => !t.isBuiltIn) }
  }),
  makeSpec("plugins", "plugins", async () => {
    const db = getDb()
    const [plugins, pluginPermissions, pluginAnalytics] = (await Promise.all([
      db.plugins.toArray(),
      db.pluginPermissions.toArray(),
      db.pluginAnalytics.toArray(),
    ])) as [PluginRow[], PluginPermissionRow[], PluginAnalyticsRow[]]
    // Don't carry built-in plugins (re-seeded locally) or marketplace
    // review caches (remote-derived). Keep permissions/jobs/analytics only
    // for user-installed plugins so the export stays self-contained.
    const userPlugins = plugins.filter((p) => p.source !== "builtin")
    const userIds = new Set(userPlugins.map((p) => p.id))
    return {
      plugins: userPlugins,
      pluginPermissions: pluginPermissions.filter((r) => userIds.has(r.pluginId)),
      pluginAnalytics: pluginAnalytics.filter((r) => userIds.has(r.pluginId)),
    }
  }),
  makeSpec("artifacts", "artifacts", async () => {
    const db = getDb()
    const [artifacts, artifactVersions] = await Promise.all([
      db.artifacts.toArray(),
      db.artifactVersions.toArray(),
    ])
    return { artifacts, artifactVersions }
  }),
  makeSpec("canvas", "canvas", async () => {
    const db = getDb()
    const [canvasDocuments, canvasVersions, canvasComments, canvasSessions] = await Promise.all([
      db.canvasDocuments.toArray(),
      db.canvasVersions.toArray(),
      listAllCanvasCommentRows(),
      db.canvasSessions.toArray(),
    ])
    return { canvasDocuments, canvasVersions, canvasComments, canvasSessions }
  }),
  makeSpec("a2ui", "a2ui", async () => {
    const db = getDb()
    const [a2uiApps, a2uiTemplates, a2uiEventHistory] = await Promise.all([
      db.a2uiApps.toArray(),
      db.a2uiTemplates.toArray(),
      db.a2uiEventHistory.toArray(),
    ])
    // Built-in apps stay locally seeded; surfaces are runtime-only.
    return {
      a2uiApps: a2uiApps.filter((a) => !a.isBuiltIn),
      a2uiTemplates,
      a2uiEventHistory,
    }
  }),
  makeSpec(
    "settingsTheme",
    "theme",
    async () => {
      const db = getDb()
      const settings = await db.settings.get("singleton")
      if (!settings) return {}
      // Carry only the appearance-y fields. We strip everything else to keep
      // theme exports portable + privacy-friendly (no API key, no telemetry).
      return {
        settings: {
          id: "singleton",
          alwaysAllowTools: settings.alwaysAllowTools ?? [],
          builtinTools: settings.builtinTools ?? DEFAULT_BUILTIN_TOOLS,
          theme: settings.theme,
          fontScale: settings.fontScale,
          language: settings.language,
          reduceMotion: settings.reduceMotion,
        },
      }
    },
    "overwrite"
  ),
  // Snapshot-backed domains (one per non-UI Zustand persist store). The UI
  // store is intentionally excluded — it's window-layout state that the
  // user shouldn't be exporting separately.
  ...DOMAIN_SNAPSHOT_MODULES.map((module) => {
    const domainKey = SNAPSHOT_DOMAIN_KEYS[module.key]
    if (!domainKey) {
      throw new Error(
        `SNAPSHOT_DOMAIN_KEYS missing entry for ${module.key} — register it in domain/index.ts`
      )
    }
    // The module's own labelKey targets `settings.data.snapshots.*`; domain
    // rows translate under `settings.data.domain.<labelKey>`, so reuse the
    // domain key here.
    return makeSnapshotSpec(domainKey, domainKey, module)
  }),
]

// §A-5 — runtime overlay so plugins (and the schema-v15 plugins domain that
// will be added once the plugin tables exist) can contribute domain transfer
// specs at runtime. Static specs in DOMAIN_TRANSFERS take precedence so a
// plugin cannot accidentally shadow a builtin transfer.
interface RegisteredDomain {
  spec: DomainSpec
  pluginId?: string
}

const dynamicDomains: RegisteredDomain[] = []

/**
 * Register a domain transfer spec at runtime. Plugins call this through the
 * plugin manager; tests call it directly. Only called for keys absent from
 * the static `DOMAIN_TRANSFERS` array — registering a key that already has
 * a static entry is allowed but the static entry wins on lookup.
 */
export function registerDomainTransfer(spec: DomainSpec, opts?: { pluginId?: string }): void {
  dynamicDomains.push({ spec, pluginId: opts?.pluginId })
}

/**
 * Drop every dynamically registered domain transfer tagged with `pluginId`.
 * Returns the number of specs removed.
 */
export function unregisterDomainTransfersByPlugin(pluginId: string): number {
  let removed = 0
  for (let i = dynamicDomains.length - 1; i >= 0; i -= 1) {
    if (dynamicDomains[i].pluginId === pluginId) {
      dynamicDomains.splice(i, 1)
      removed += 1
    }
  }
  return removed
}

/** Test-only escape hatch for cleaning up the dynamic overlay between tests. */
export function __resetDynamicDomainsForTesting(): void {
  dynamicDomains.length = 0
}

/**
 * Returns every domain spec available to the export/import flows: the static
 * builtins plus any plugin-contributed specs. Used by the domain-transfer UI
 * to render the per-domain checklist; per-domain code paths still call
 * `getDomain(key)` for a single lookup.
 */
export function getAllDomainTransfers(): DomainSpec[] {
  return [...DOMAIN_TRANSFERS, ...dynamicDomains.map((d) => d.spec)]
}

export function getDomain(key: DomainKey): DomainSpec | undefined {
  // Static wins; fall through to dynamic so plugin-registered keys (e.g.,
  // a plugin's own settings table) resolve too.
  return (
    DOMAIN_TRANSFERS.find((d) => d.key === key) ??
    dynamicDomains.find((d) => d.spec.key === key)?.spec
  )
}

/** Build an exportable JSON file for a single domain. */
export async function buildDomainExport(key: DomainKey): Promise<DomainExportFile> {
  const spec = getDomain(key)
  if (!spec) throw new Error(`Unknown domain: ${key}`)
  const payload = await spec.read()
  return {
    version: "cognia-domain-1.0",
    domain: key,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    payload,
  }
}

export function serializeDomainFile(file: DomainExportFile): string {
  return JSON.stringify(file, null, 2)
}

export function detectDomainFile(input: unknown): input is DomainExportFile {
  if (!input || typeof input !== "object") return false
  const obj = input as { version?: unknown; domain?: unknown; payload?: unknown }
  return (
    obj.version === "cognia-domain-1.0" &&
    typeof obj.domain === "string" &&
    !!obj.payload &&
    typeof obj.payload === "object"
  )
}

/** Apply a domain file under the chosen merge strategy. Reuses the backup engine. */
export async function applyDomainImport(
  file: DomainExportFile,
  strategy: ImportMergeStrategy
): Promise<ImportSummary> {
  // Wrap the domain payload as a v3 package so we can reuse `applyBackupPackage`
  // — same merge logic, same built-in protection, same transactional safety.
  const pkg: BackupPackageV3 = {
    version: "3.0",
    manifest: {
      version: "3.0",
      schemaVersion: EXPORT_SCHEMA_VERSION,
      traceId: "domain-import-" + Math.random().toString(36).slice(2, 10),
      exportedAt: file.exportedAt,
      appVersion: file.appVersion,
      backend: "web-dexie",
      integrity: {
        algorithm: "SHA-256",
        checksum: await sha256Hex(canonicalStringify(file.payload)),
      },
    },
    payload: file.payload,
  }
  return applyBackupPackage(pkg, {
    mergeStrategy: strategy,
    includeSessions: false,
    includeApiKey: false,
  })
}

export function defaultDomainFileName(key: DomainKey, now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `cognia-${key}-${y}-${m}-${d}.json`
}
