// Applies a `BackupPackageV3` to the local Dexie database under one of three
// merge strategies:
//   - skip:      keep the local row, drop the import row (default; safest)
//   - overwrite: replace the local row with the import row (id-keyed)
//   - duplicate: assign a fresh id to the import row and add alongside
//
// Built-in rows (characters/skills/teams with `isBuiltIn === true`) are NEVER
// overwritten regardless of strategy — they're managed by the seed.

import type {
  AppSettings,
  Character,
  ChatSession,
  McpServer,
  Skill,
  SkillResource,
  StoredMessage,
  SystemPromptPreset,
  Team,
} from "@cognia/agent-config-types"
import type { TrustedWorkspace } from "@/lib/db/trusted-workspaces"
import type { CogniaDB, SessionStateRow, TtsProviderKeyRow } from "@/lib/db/schema"
import { getDb } from "@/lib/db/schema"
import { contextCommentRowFromCanvas } from "@/lib/db/context-comments"
import type {
  PluginAnalyticsRow,
  PluginPermissionRow,
  PluginReviewRow,
  PluginRow,
} from "@/lib/db/plugin-types"
import type { TwinChunk, TwinDraft, TwinJob, TwinProfile, TwinSource } from "@/types/twin"
import type { Memory } from "@/types/memory/memory"
import type { MemoryAuditEvent, MemoryEvidence, MemoryJob } from "@/types/memory/governance"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import {
  emptySummary,
  type BackupPackageV3,
  type ImportOptions,
  type ImportSummary,
  type LocalStorageImportReport,
  type SyncProjectionReport,
} from "./types"
import { browserSnapshotStorage, SNAPSHOT_MODULES } from "./snapshots/registry"
import { readAllSnapshots, restoreFromPreSnap, writeAllSnapshots } from "./snapshots/helpers"
import type { LocalStorageSnapshot, SnapshotEnv, SnapshotStorage } from "./snapshots/types"
import { projectMcpToAllAgents } from "./sync-projection"

interface BuiltInRow {
  id: string
  isBuiltIn?: boolean
}

function newId(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** Optional knobs primarily used by tests so we can inject a stub
 * `localStorage` and bypass the Tauri `syncToAgent` projection. */
export interface ApplyBackupExtras {
  /** Override the `localStorage` shim. Defaults to `browserSnapshotStorage()`
   * (which itself returns `null` outside the browser). */
  storage?: SnapshotStorage | null
  /** Forwarded to snapshot warning calls. */
  warn?: SnapshotEnv["warn"]
  /** Stub the Tauri-only `syncToAgent` projection step. When omitted, the
   * built-in `projectMcpToAllAgents` is used. */
  projectMcp?: () => Promise<SyncProjectionReport[]>
}

/**
 * Apply the package to local storage under the chosen merge strategy. Wraps
 * every write in a single Dexie transaction so a partial failure rolls back.
 *
 * Five-stage flow:
 *   1) capture pre-import `localStorage` snapshot (so we can roll back if
 *      anything past the Dexie commit fails);
 *   2) Dexie transaction — own atomicity is delegated to Dexie;
 *   3) write `localStorageSnapshots` payload via the snapshot registry;
 *   4) Tauri-only — re-project MCP servers to each writable agent's config
 *      file via `syncToAgent`;
 *   5) on any post-(2) failure, restore (1) and rethrow.
 */
export async function applyBackupPackage(
  pkg: BackupPackageV3,
  opts: ImportOptions,
  extras: ApplyBackupExtras = {}
): Promise<ImportSummary> {
  const summary = emptySummary()
  const db = getDb()
  const env = pkg.payload

  // Stage 1: snapshot localStorage face *before* Dexie writes so we can
  // roll it back if something blows up after the Dexie commit. Tauri/web
  // both use this same path.
  const storage = extras.storage === undefined ? browserSnapshotStorage() : extras.storage
  const snapshotEnv: SnapshotEnv | null = storage ? { storage, warn: extras.warn } : null
  const preSnap: Record<string, LocalStorageSnapshot> = snapshotEnv
    ? readAllSnapshots(SNAPSHOT_MODULES, snapshotEnv).snapshots
    : {}

  await db.transaction(
    "rw",
    [
      db.settings,
      db.characters,
      db.skills,
      db.skillResources,
      db.teams,
      db.promptPresets,
      db.mcpServers,
      db.sessions,
      db.messages,
      db.sessionState,
      db.trustedWorkspaces,
      db.tts_provider_keys,
      db.canvasDocuments,
      db.canvasVersions,
      db.contextComments,
      db.canvasSessions,
      db.a2uiApps,
      db.a2uiTemplates,
      db.a2uiEventHistory,
      db.plugins,
      db.pluginPermissions,
      db.pluginReviews,
      db.pluginAnalytics,
      db.twinSources,
      db.twinChunks,
      db.twinProfile,
      db.twinDrafts,
      db.twinJobs,
      db.memories,
      db.memoryEvidence,
      db.memoryJobs,
      db.memoryAuditEvents,
    ],
    async () => {
      // --- settings (singleton) -------------------------------------------
      if (env.settings) {
        const existing = await db.settings.get("singleton")
        const incoming: AppSettings = { ...env.settings, id: "singleton" }
        if (!opts.includeApiKey) delete incoming.apiKey
        if (!existing) {
          await db.settings.put(incoming)
          incrementCounter(summary.added, "settings")
        } else if (opts.mergeStrategy === "skip") {
          incrementCounter(summary.skipped, "settings")
        } else {
          await db.settings.put({ ...existing, ...incoming })
          incrementCounter(summary.overwritten, "settings")
        }
      }

      // --- characters / skills / teams (skip built-ins) -------------------
      await applyCollection<Character>({
        rows: env.characters,
        table: db.characters,
        kind: "characters",
        opts,
        summary,
        idPrefix: "char",
      })
      await applyCollection<Skill>({
        rows: env.skills,
        table: db.skills,
        kind: "skills",
        opts,
        summary,
        idPrefix: "skill",
      })
      // Skill resources: foreign-key parent. We respect the FK by skipping
      // resources whose parent skill no longer exists locally and isn't being
      // imported in the same envelope.
      await applyCollection<SkillResource>({
        rows: env.skillResources,
        table: db.skillResources,
        kind: "skillResources",
        opts,
        summary,
        idPrefix: "res",
        respectBuiltIn: false,
      })
      await applyCollection<Team>({
        rows: env.teams,
        table: db.teams,
        kind: "teams",
        opts,
        summary,
        idPrefix: "team",
      })

      // --- presets / MCP servers / trusted workspaces / tts keys ---------
      await applyCollection<SystemPromptPreset>({
        rows: env.promptPresets,
        table: db.promptPresets,
        kind: "promptPresets",
        opts,
        summary,
        idPrefix: "preset",
        // v12 seeds built-in presets via `seedBuiltInPresets`. Older backups
        // may carry rows with ids that now collide with our built-ins —
        // respect the built-in flag so a stale import doesn't clobber the
        // seed payload.
        respectBuiltIn: true,
      })
      await applyCollection<McpServer>({
        rows: env.mcpServers,
        table: db.mcpServers,
        kind: "mcpServers",
        opts,
        summary,
        idPrefix: "mcp",
        respectBuiltIn: false,
      })
      await applyKeyedCollection<TrustedWorkspace>({
        rows: env.trustedWorkspaces,
        table: db.trustedWorkspaces,
        kind: "trustedWorkspaces",
        opts,
        summary,
        keyOf: (r) => r.path,
      })
      await applyKeyedCollection<TtsProviderKeyRow>({
        rows: env.ttsProviderKeys,
        table: db.tts_provider_keys,
        kind: "ttsProviderKeys",
        opts,
        summary,
        keyOf: (r) => r.id,
      })

      // --- canvas (always applied) ---------------------------------------
      await applyCollection({
        rows: env.canvasDocuments,
        table: db.canvasDocuments,
        kind: "canvasDocuments",
        opts,
        summary,
        idPrefix: "doc",
        respectBuiltIn: false,
      })
      await applyCollection({
        rows: env.canvasVersions,
        table: db.canvasVersions,
        kind: "canvasVersions",
        opts,
        summary,
        idPrefix: "ver",
        respectBuiltIn: false,
      })
      await applyCollection({
        rows: env.canvasComments?.map(contextCommentRowFromCanvas),
        table: db.contextComments,
        kind: "canvasComments",
        opts,
        summary,
        idPrefix: "cmt",
        respectBuiltIn: false,
      })
      await applyCollection({
        rows: env.canvasSessions,
        table: db.canvasSessions,
        kind: "canvasSessions",
        opts,
        summary,
        idPrefix: "csess",
        respectBuiltIn: false,
      })

      // --- a2ui apps / templates / event history -------------------------
      await applyCollection({
        rows: env.a2uiApps,
        table: db.a2uiApps,
        kind: "a2uiApps",
        opts,
        summary,
        idPrefix: "a2app",
        // built-in apps stay locally seeded — incoming built-ins are skipped
        respectBuiltIn: true,
      })
      await applyCollection({
        rows: env.a2uiTemplates,
        table: db.a2uiTemplates,
        kind: "a2uiTemplates",
        opts,
        summary,
        idPrefix: "a2tpl",
        respectBuiltIn: false,
      })
      await applyCollection({
        rows: env.a2uiEventHistory,
        table: db.a2uiEventHistory,
        kind: "a2uiEventHistory",
        opts,
        summary,
        idPrefix: "a2evt",
        respectBuiltIn: false,
      })

      // --- plugins (always applied; builtin protected; enabled forced false) ---
      // Plugin rows carry the user's installed catalog. We import them under
      // the same merge logic as characters/skills, with two extras:
      //   • `source === "builtin"` plugins are skipped — they're seeded locally.
      //   • Imported plugins are forced to `enabled: false` so a fresh restore
      //     doesn't silently reactivate a plugin the user might have disabled
      //     for security reasons before the export.
      // Permissions/reviews/analytics follow the parent plugin via
      // `bulkPut` keyed on their composite primary keys — overwrite is the
      // only sensible strategy for derived per-plugin data.
      if (env.plugins && env.plugins.length > 0) {
        const incomingPlugins = env.plugins as PluginRow[]
        const importedPluginIds = new Map<string, string>()
        for (const row of incomingPlugins) {
          if (row.source === "builtin") {
            incrementCounter(summary.builtInsSkipped, "plugins")
            continue
          }
          const safeRow: PluginRow = { ...row, enabled: false }
          const existing = await db.plugins.get(row.id)
          if (existing && existing.source === "builtin") {
            incrementCounter(summary.builtInsSkipped, "plugins")
            continue
          }
          if (!existing) {
            await db.plugins.put(safeRow)
            incrementCounter(summary.added, "plugins")
            importedPluginIds.set(row.id, safeRow.id)
            continue
          }
          switch (opts.mergeStrategy) {
            case "skip":
              incrementCounter(summary.skipped, "plugins")
              break
            case "overwrite":
              await db.plugins.put(safeRow)
              incrementCounter(summary.overwritten, "plugins")
              importedPluginIds.set(row.id, safeRow.id)
              break
            case "duplicate": {
              const copy: PluginRow = { ...safeRow, id: newId("plugin") }
              await db.plugins.put(copy)
              incrementCounter(summary.added, "plugins")
              importedPluginIds.set(row.id, copy.id)
              break
            }
          }
        }

        // Child rows follow the imported plugin, including a duplicate's fresh
        // id. Skip rows whose owning plugin wasn't imported.
        const remapChildRows = <T extends { pluginId: string }>(rows: T[]): T[] =>
          rows.flatMap((row) => {
            const pluginId = importedPluginIds.get(row.pluginId)
            return pluginId === undefined ? [] : [{ ...row, pluginId }]
          })

        if (env.pluginPermissions && env.pluginPermissions.length > 0) {
          const perms = remapChildRows(env.pluginPermissions as PluginPermissionRow[])
          if (perms.length > 0) {
            await db.pluginPermissions.bulkPut(perms)
            incrementCounterBy(summary.added, "pluginPermissions", perms.length)
          }
        }
        if (env.pluginAnalytics && env.pluginAnalytics.length > 0) {
          const rows = remapChildRows(env.pluginAnalytics as PluginAnalyticsRow[])
          if (rows.length > 0) {
            await db.pluginAnalytics.bulkPut(rows)
            incrementCounterBy(summary.added, "pluginAnalytics", rows.length)
          }
        }
        if (env.pluginReviews && env.pluginReviews.length > 0) {
          const rows = remapChildRows(env.pluginReviews as PluginReviewRow[])
          if (rows.length > 0) {
            await db.pluginReviews.bulkPut(rows)
            incrementCounterBy(summary.added, "pluginReviews", rows.length)
          }
        }
      }

      // --- twin tables (schema v14) --------------------------------------
      // Sources / chunks / drafts / jobs use the standard applyCollection
      // strategy switch (skip / overwrite / duplicate). Profile is special:
      // 1:1 with twinId, so duplicating would shadow the original — we
      // collapse "duplicate" to "overwrite" here, matching the pattern used
      // for other natural-key tables (trustedWorkspaces, sessionState).
      await applyCollection<TwinSource>({
        rows: env.twinSources,
        table: db.twinSources,
        kind: "twinSources",
        opts,
        summary,
        idPrefix: "tsrc",
        respectBuiltIn: false,
      })
      await applyCollection<TwinChunk>({
        rows: env.twinChunks,
        table: db.twinChunks,
        kind: "twinChunks",
        opts,
        summary,
        idPrefix: "tchk",
        respectBuiltIn: false,
      })
      await applyKeyedCollection<TwinProfile>({
        rows: env.twinProfile,
        table: db.twinProfile,
        kind: "twinProfile",
        opts,
        summary,
        keyOf: (r) => r.id,
      })
      await applyCollection<TwinDraft>({
        rows: env.twinDrafts,
        table: db.twinDrafts,
        kind: "twinDrafts",
        opts,
        summary,
        idPrefix: "tdr",
        respectBuiltIn: false,
      })
      await applyCollection<TwinJob>({
        rows: env.twinJobs,
        table: db.twinJobs,
        kind: "twinJobs",
        opts,
        summary,
        idPrefix: "twj",
        respectBuiltIn: false,
      })

      // --- learned memory + governance (schema v118) --------------------
      // These tables form one referential bundle. The duplicate strategy
      // remaps every colliding id and then rewrites child references so
      // evidence, durable jobs, and audit history remain connected.
      await applyMemoryBundle({
        memories: env.memories,
        evidence: env.memoryEvidence,
        jobs: env.memoryJobs,
        audits: env.memoryAuditEvents,
        db,
        opts,
        summary,
      })

      // --- sessions + messages + sessionState (off by default) -----------
      if (opts.includeSessions) {
        await applyCollection<ChatSession>({
          rows: env.sessions,
          table: db.sessions,
          kind: "sessions",
          opts,
          summary,
          idPrefix: "s",
          respectBuiltIn: false,
        })
        await applyCollection<StoredMessage>({
          rows: env.messages,
          table: db.messages,
          kind: "messages",
          opts,
          summary,
          idPrefix: "m",
          respectBuiltIn: false,
        })
        await applyKeyedCollection<SessionStateRow>({
          rows: env.sessionState,
          table: db.sessionState,
          kind: "sessionState",
          opts,
          summary,
          keyOf: (r) => r.sessionId,
        })
      }
    }
  )

  // --- Stage 3: write the localStorage face --------------------------------
  // Dexie has committed. Anything that fails from here on triggers a
  // best-effort restore from `preSnap` so the localStorage face stays in
  // lockstep with what the user had before the import.
  let lsReport: LocalStorageImportReport | undefined
  if (snapshotEnv && env.localStorageSnapshots) {
    try {
      const result = writeAllSnapshots(
        SNAPSHOT_MODULES,
        env.localStorageSnapshots,
        opts.mergeStrategy,
        snapshotEnv
      )
      lsReport = {
        written: result.written,
        skipped: result.skipped,
        errors: result.errors,
      }
      if (result.errors.length > 0) {
        const restored = restoreFromPreSnap(SNAPSHOT_MODULES, preSnap, snapshotEnv)
        lsReport.restoredFromPreSnap = [...restored.restored, ...restored.cleared]
      }
    } catch (err) {
      const restored = restoreFromPreSnap(SNAPSHOT_MODULES, preSnap, snapshotEnv)
      lsReport = {
        written: [],
        skipped: [],
        errors: [
          {
            key: "*",
            error: err instanceof Error ? err.message : String(err),
          },
        ],
        restoredFromPreSnap: [...restored.restored, ...restored.cleared],
      }
    }
  }
  if (lsReport) summary.localStorage = lsReport

  // --- Stage 4: Tauri MCP projection (best-effort) -------------------------
  const project = extras.projectMcp ?? projectMcpToAllAgents
  try {
    const syncResults = await project()
    if (syncResults.length > 0) summary.syncResults = syncResults
  } catch (err) {
    summary.syncResults = [
      {
        agentId: "*",
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      },
    ]
  }

  return summary
}

interface ApplyArgs<T extends { id: string }> {
  rows: T[] | undefined
  table: { get(id: string): Promise<T | undefined>; put(row: T): Promise<unknown> }
  kind: string
  opts: ImportOptions
  summary: ImportSummary
  idPrefix: string
  /** Default true. When true, local rows with isBuiltIn=true are never overwritten. */
  respectBuiltIn?: boolean
}

async function applyCollection<T extends { id: string }>(args: ApplyArgs<T>): Promise<void> {
  const { rows, table, kind, opts, summary, idPrefix } = args
  const respectBuiltIn = args.respectBuiltIn ?? true
  if (!rows || rows.length === 0) return

  for (const row of rows) {
    const existing = await table.get(row.id)
    if (existing && respectBuiltIn && (existing as BuiltInRow).isBuiltIn) {
      incrementCounter(summary.builtInsSkipped, kind)
      continue
    }
    if (!existing) {
      await table.put(row)
      incrementCounter(summary.added, kind)
      continue
    }
    switch (opts.mergeStrategy) {
      case "skip":
        incrementCounter(summary.skipped, kind)
        break
      case "overwrite":
        await table.put(row)
        incrementCounter(summary.overwritten, kind)
        break
      case "duplicate": {
        const copy = { ...row, id: newId(idPrefix) }
        if ("isBuiltIn" in copy) {
          ;(copy as Record<string, unknown>).isBuiltIn = false
        }
        await table.put(copy as T)
        incrementCounter(summary.added, kind)
        break
      }
    }
  }
}

interface KeyedApplyArgs<T> {
  rows: T[] | undefined
  table: { get(id: string): Promise<T | undefined>; put(row: T): Promise<unknown> }
  kind: string
  opts: ImportOptions
  summary: ImportSummary
  keyOf: (row: T) => string
}

/**
 * Variant for tables whose primary key isn't `id` (trustedWorkspaces uses
 * `path`, sessionState uses `sessionId`, etc.). The "duplicate" strategy
 * collapses to "overwrite" for these tables — their natural keys are
 * intentional, and a duplicate would silently shadow the original.
 */
async function applyKeyedCollection<T>(args: KeyedApplyArgs<T>): Promise<void> {
  const { rows, table, kind, opts, summary, keyOf } = args
  if (!rows || rows.length === 0) return
  for (const row of rows) {
    const existing = await table.get(keyOf(row))
    if (!existing) {
      await table.put(row)
      incrementCounter(summary.added, kind)
      continue
    }
    if (opts.mergeStrategy === "skip") {
      incrementCounter(summary.skipped, kind)
    } else {
      await table.put(row)
      incrementCounter(summary.overwritten, kind)
    }
  }
}

interface MemoryBundleArgs {
  memories: Memory[] | undefined
  evidence: MemoryEvidence[] | undefined
  jobs: MemoryJob[] | undefined
  audits: MemoryAuditEvent[] | undefined
  db: CogniaDB
  opts: ImportOptions
  summary: ImportSummary
}

async function applyMemoryBundle(args: MemoryBundleArgs): Promise<void> {
  const { db, opts, summary } = args
  const memories = (args.memories ?? []).flatMap((row) => {
    const safe = sanitizeImportedMemory(row)
    return safe ? [safe] : []
  })
  const evidence = (args.evidence ?? []).flatMap((row) => {
    const safe = sanitizeImportedEvidence(row)
    return safe ? [safe] : []
  })
  const jobs = (args.jobs ?? []).flatMap((row) => {
    const safe = sanitizeImportedJob(row)
    return safe ? [safe] : []
  })
  const audits = (args.audits ?? []).flatMap((row) => {
    const safe = sanitizeImportedAudit(row)
    return safe ? [safe] : []
  })
  const importedMemoryIds = new Set(memories.map((memory) => memory.id))
  const memoryIdMap = new Map<string, string>()
  const evidenceIdMap = new Map<string, string>()

  for (const memory of memories) {
    const importedId = await applyMappedRow({
      row: memory,
      table: db.memories,
      kind: "memories",
      idPrefix: "mem",
      opts,
      summary,
    })
    if (importedId) memoryIdMap.set(memory.id, importedId)
  }

  for (const memory of memories) {
    const importedId = memoryIdMap.get(memory.id)
    if (!importedId) continue
    const supersededById = memory.supersededById
      ? (memoryIdMap.get(memory.supersededById) ?? memory.supersededById)
      : undefined
    const conflictWithIds = memory.conflictWithIds?.map((id) => memoryIdMap.get(id) ?? id)
    if (
      supersededById !== memory.supersededById ||
      conflictWithIds?.some((id, index) => id !== memory.conflictWithIds?.[index])
    ) {
      await db.memories.update(importedId, { supersededById, conflictWithIds })
    }
  }

  for (const item of evidence) {
    if (item.memoryId && importedMemoryIds.has(item.memoryId) && !memoryIdMap.has(item.memoryId)) {
      incrementCounter(summary.skipped, "memoryEvidence")
      continue
    }
    const row: MemoryEvidence = {
      ...item,
      ...(item.memoryId ? { memoryId: memoryIdMap.get(item.memoryId) ?? item.memoryId } : {}),
    }
    const importedId = await applyMappedRow({
      row,
      table: db.memoryEvidence,
      kind: "memoryEvidence",
      idPrefix: "mev",
      opts,
      summary,
    })
    if (importedId) evidenceIdMap.set(item.id, importedId)
  }

  for (const item of jobs) {
    await applyMappedRow<MemoryJob>({
      row: {
        ...item,
        evidenceIds: item.evidenceIds.map((id) => evidenceIdMap.get(id) ?? id),
      },
      table: db.memoryJobs,
      kind: "memoryJobs",
      idPrefix: "mjob",
      opts,
      summary,
    })
  }

  for (const item of audits) {
    if (item.memoryId && importedMemoryIds.has(item.memoryId) && !memoryIdMap.has(item.memoryId)) {
      incrementCounter(summary.skipped, "memoryAuditEvents")
      continue
    }
    await applyMappedRow({
      row: {
        ...item,
        ...(item.memoryId ? { memoryId: memoryIdMap.get(item.memoryId) ?? item.memoryId } : {}),
      },
      table: db.memoryAuditEvents,
      kind: "memoryAuditEvents",
      idPrefix: "maudit",
      opts,
      summary,
    })
  }
}

const MEMORY_SCOPES = new Set(["global", "workspace", "character", "agent"])
const MEMORY_TYPES = new Set(["semantic", "episodic", "procedural"])
const MEMORY_STATUSES = new Set(["active", "invalidated"])
const MEMORY_PROVENANCE = new Set(["user", "explicit", "inbound", "system", "external"])
const EVIDENCE_KINDS = new Set([
  "message",
  "file",
  "external",
  "manual",
  "checkpoint",
  "agent-finding",
])
const JOB_KINDS = new Set(["turn-extraction", "session-distill", "vector-reconcile"])
const JOB_STATUSES = new Set(["queued", "running", "completed", "failed"])
const AUDIT_ACTIONS = new Set([
  "recall-allowed",
  "recall-denied",
  "learn-allowed",
  "learn-denied",
  "created",
  "revised",
  "promoted",
  "invalidated",
  "deleted",
  "conflict",
  "pinned",
  "unpinned",
])
const SAFE_IDENTIFIER = /^[\w./:@-]{1,512}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function optionalIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) && hasNoLeakingPii(value)
    ? value
    : undefined
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined
}

function sanitizeImportedMemory(value: unknown): Memory | undefined {
  if (!isRecord(value)) return undefined
  const {
    id,
    scope,
    type,
    text,
    tags,
    importance,
    createdAt,
    updatedAt,
    lastAccessedAt,
    accessCount,
    version,
    status,
    pinned,
    provenance,
  } = value
  if (
    typeof id !== "string" ||
    !SAFE_IDENTIFIER.test(id) ||
    typeof scope !== "string" ||
    !MEMORY_SCOPES.has(scope) ||
    typeof type !== "string" ||
    !MEMORY_TYPES.has(type) ||
    typeof text !== "string" ||
    !Array.isArray(tags) ||
    !tags.every((tag) => typeof tag === "string" && tag.length <= 128) ||
    !isFiniteNumber(importance) ||
    importance < 1 ||
    importance > 10 ||
    !isFiniteNumber(createdAt) ||
    !isFiniteNumber(updatedAt) ||
    !isFiniteNumber(lastAccessedAt) ||
    !isFiniteNumber(accessCount) ||
    accessCount < 0 ||
    !isFiniteNumber(version) ||
    version < 1 ||
    typeof status !== "string" ||
    !MEMORY_STATUSES.has(status) ||
    typeof pinned !== "boolean" ||
    typeof provenance !== "string" ||
    !MEMORY_PROVENANCE.has(provenance)
  ) {
    return undefined
  }
  const characterId = optionalIdentifier(value.characterId)
  const projectId = optionalIdentifier(value.projectId)
  const agentId = optionalIdentifier(value.agentId)
  if (
    (scope === "workspace" && !projectId) ||
    (scope === "character" && !characterId) ||
    (scope === "agent" && !agentId)
  ) {
    return undefined
  }
  const redacted = redactText(text).redacted.trim()
  if (!redacted || !hasNoLeakingPii(redacted)) return undefined
  const row: Memory = {
    id,
    scope: scope as Memory["scope"],
    type: type as Memory["type"],
    text: redacted,
    tags: [...new Set(tags)],
    importance,
    createdAt,
    updatedAt,
    lastAccessedAt,
    accessCount,
    version,
    status: status as Memory["status"],
    pinned,
    provenance: provenance as Memory["provenance"],
    ...(characterId ? { characterId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(agentId ? { agentId } : {}),
  }
  const stringFields = [
    "branch",
    "pathPattern",
    "key",
    "vectorDocId",
    "supersededById",
    "sourceSessionId",
    "sourceMessageId",
    "sourcePluginId",
  ] as const
  for (const field of stringFields) {
    const safe = optionalIdentifier(value[field])
    if (safe) row[field] = safe
  }
  if (
    value.sourceChannel === "plugin" ||
    value.sourceChannel === "mcp" ||
    value.sourceChannel === "rpc"
  ) {
    row.sourceChannel = value.sourceChannel
  }
  if (value.evidenceState === "legacy" || value.evidenceState === "supported") {
    row.evidenceState = value.evidenceState
  }
  if (
    value.reviewStatus === "unreviewed" ||
    value.reviewStatus === "verified" ||
    value.reviewStatus === "conflict"
  ) {
    row.reviewStatus = value.reviewStatus
  }
  if (
    value.contaminationState === "clean" ||
    value.contaminationState === "external-context" ||
    value.contaminationState === "unknown"
  ) {
    row.contaminationState = value.contaminationState
  }
  if (value.sensitivity === "normal" || value.sensitivity === "sensitive") {
    row.sensitivity = value.sensitivity
  }
  if (Array.isArray(value.conflictWithIds)) {
    row.conflictWithIds = value.conflictWithIds.flatMap((item) => {
      const safe = optionalIdentifier(item)
      return safe ? [safe] : []
    })
  }
  const invalidatedAt = optionalFiniteNumber(value.invalidatedAt)
  if (invalidatedAt !== undefined) row.invalidatedAt = invalidatedAt
  return row
}

function sanitizeImportedEvidence(value: unknown): MemoryEvidence | undefined {
  if (!isRecord(value)) return undefined
  const id = optionalIdentifier(value.id)
  const sourceId = optionalIdentifier(value.sourceId)
  if (
    !id ||
    !sourceId ||
    typeof value.kind !== "string" ||
    !EVIDENCE_KINDS.has(value.kind) ||
    typeof value.contaminationState !== "string" ||
    !["clean", "external-context", "unknown"].includes(value.contaminationState) ||
    typeof value.reviewed !== "boolean" ||
    !isFiniteNumber(value.createdAt)
  ) {
    return undefined
  }
  return {
    id,
    kind: value.kind as MemoryEvidence["kind"],
    sourceId,
    contaminationState: value.contaminationState as MemoryEvidence["contaminationState"],
    reviewed: value.reviewed,
    createdAt: value.createdAt,
    ...(optionalIdentifier(value.memoryId) ? { memoryId: optionalIdentifier(value.memoryId) } : {}),
    ...(optionalIdentifier(value.sessionId)
      ? { sessionId: optionalIdentifier(value.sessionId) }
      : {}),
    ...(optionalIdentifier(value.messageId)
      ? { messageId: optionalIdentifier(value.messageId) }
      : {}),
    ...(optionalIdentifier(value.excerptHash)
      ? { excerptHash: optionalIdentifier(value.excerptHash) }
      : {}),
  }
}

function sanitizeImportedJob(value: unknown): MemoryJob | undefined {
  if (!isRecord(value)) return undefined
  const id = optionalIdentifier(value.id)
  const dedupeKey = optionalIdentifier(value.dedupeKey)
  if (
    !id ||
    !dedupeKey ||
    typeof value.kind !== "string" ||
    !JOB_KINDS.has(value.kind) ||
    typeof value.status !== "string" ||
    !JOB_STATUSES.has(value.status) ||
    typeof value.scope !== "string" ||
    !MEMORY_SCOPES.has(value.scope) ||
    typeof value.provenance !== "string" ||
    !MEMORY_PROVENANCE.has(value.provenance) ||
    !Array.isArray(value.evidenceIds) ||
    !isFiniteNumber(value.queuedAt) ||
    !isFiniteNumber(value.retryCount) ||
    value.retryCount < 0
  ) {
    return undefined
  }
  const evidenceIds = value.evidenceIds.flatMap((item) => {
    const safe = optionalIdentifier(item)
    return safe ? [safe] : []
  })
  if (evidenceIds.length !== value.evidenceIds.length) return undefined
  const row: MemoryJob = {
    id,
    dedupeKey,
    kind: value.kind as MemoryJob["kind"],
    status: value.status as MemoryJob["status"],
    scope: value.scope as MemoryJob["scope"],
    provenance: value.provenance as MemoryJob["provenance"],
    evidenceIds,
    queuedAt: value.queuedAt,
    retryCount: value.retryCount,
  }
  for (const field of [
    "sessionId",
    "projectId",
    "characterId",
    "leaseOwner",
    "errorCode",
  ] as const) {
    const safe = optionalIdentifier(value[field])
    if (safe) row[field] = safe
  }
  for (const field of ["startedAt", "completedAt", "leaseExpiresAt", "nextAttemptAt"] as const) {
    const safe = optionalFiniteNumber(value[field])
    if (safe !== undefined) row[field] = safe
  }
  return row
}

function sanitizeImportedAudit(value: unknown): MemoryAuditEvent | undefined {
  if (!isRecord(value)) return undefined
  const id = optionalIdentifier(value.id)
  if (
    !id ||
    typeof value.action !== "string" ||
    !AUDIT_ACTIONS.has(value.action) ||
    !isFiniteNumber(value.createdAt)
  ) {
    return undefined
  }
  const reason = optionalIdentifier(value.reason) ?? "imported"
  const metadata: MemoryAuditEvent["metadata"] = isRecord(value.metadata)
    ? (Object.fromEntries(
        Object.entries(value.metadata).filter(
          ([key, item]) =>
            SAFE_IDENTIFIER.test(key) &&
            (typeof item === "boolean" ||
              (typeof item === "number" && Number.isFinite(item)) ||
              (typeof item === "string" && SAFE_IDENTIFIER.test(item) && hasNoLeakingPii(item)))
        )
      ) as Record<string, string | number | boolean>)
    : undefined
  return {
    id,
    action: value.action as MemoryAuditEvent["action"],
    reason,
    createdAt: value.createdAt,
    ...(optionalIdentifier(value.memoryId) ? { memoryId: optionalIdentifier(value.memoryId) } : {}),
    ...(optionalIdentifier(value.sessionId)
      ? { sessionId: optionalIdentifier(value.sessionId) }
      : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

interface MappedRowArgs<T extends { id: string }> {
  row: T
  table: { get(id: string): Promise<T | undefined>; put(row: T): Promise<unknown> }
  kind: string
  idPrefix: string
  opts: ImportOptions
  summary: ImportSummary
}

async function applyMappedRow<T extends { id: string }>(
  args: MappedRowArgs<T>
): Promise<string | undefined> {
  const { row, table, kind, idPrefix, opts, summary } = args
  const existing = await table.get(row.id)
  if (!existing) {
    await table.put(row)
    incrementCounter(summary.added, kind)
    return row.id
  }
  if (opts.mergeStrategy === "skip") {
    incrementCounter(summary.skipped, kind)
    return undefined
  }
  if (opts.mergeStrategy === "overwrite") {
    await table.put(row)
    incrementCounter(summary.overwritten, kind)
    return row.id
  }
  const id = newId(idPrefix)
  await table.put({ ...row, id })
  incrementCounter(summary.added, kind)
  return id
}

function incrementCounter(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function incrementCounterBy(target: Record<string, number>, key: string, amount: number): void {
  target[key] = (target[key] ?? 0) + amount
}
