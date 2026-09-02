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
import type { ChatTemplateRow } from "@/lib/db/chat-templates"
import type { TemplateDefinitionRow, TemplatePackageRow } from "@/lib/db/template-platform"
import type { TemplateInstanceRecord } from "@/lib/templates/repository"
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
import { isMemorySourceChannel, isProjectMemoryKind, type Memory } from "@/types/memory/memory"
import {
  MEMORY_EVIDENCE_KINDS,
  MEMORY_JOB_KINDS,
  isMemoryValidationStrategy,
  type MemoryAuditEvent,
  type MemoryEvidence,
  type MemoryJob,
  type MemoryJobCheckpoint,
} from "@/types/memory/governance"
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
import {
  importProfiles as validateProfilesImport,
  PROFILE_STORE_SCHEMA_VERSION,
} from "@cognia/provider-types"
import { deepStripSecrets } from "@/lib/settings/profile-transfer"
import type {
  RetrievalEncryptedContentRow,
  RetrievalProfileRow,
} from "@/lib/db/retrieval-control-types"
import { importPortableRetrievalKeys, type PortableImportStore } from "./retrieval-key-backup"

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
  /** Test/runtime seam for the native keyring or Browser Vault. */
  profileDekStore?: PortableImportStore
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
  const importedProfiles = env.providerProfileStore
    ? validateProfilesImport(env.providerProfileStore)
    : undefined
  if (importedProfiles && !importedProfiles.ok) {
    throw new Error(`provider profile import failed: ${importedProfiles.errors.join("; ")}`)
  }
  const retrievalProfiles = (env.retrievalProfiles ?? []).map(validateRetrievalProfileRow)
  const retrievalEncryptedContent = (env.retrievalEncryptedContent ?? []).flatMap((row) =>
    row.kind === "lexical_segment" ? [] : [validateRetrievalEncryptedContentRow(row)]
  )
  summary.restoredRetrievalKeyProfiles = await importPortableRetrievalKeys(
    env.retrievalProfileDeks,
    opts.retrievalDekPassphrase,
    extras.profileDekStore
  )

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
      db.artifacts,
      db.artifactVersions,
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
      db.retrievalProfiles,
      db.retrievalEncryptedContent,
      db.chatTemplates,
      db.templateDefinitions,
      db.templatePackages,
      db.templateInstances,
      db.providerProfiles,
      db.deploymentProfiles,
      db.transportProfiles,
      db.profileStoreMeta,
    ],
    async () => {
      // --- settings (singleton) -------------------------------------------
      if (env.settings) {
        const existing = await db.settings.get("singleton")
        const incoming = (
          opts.includeApiKey
            ? { ...env.settings, id: "singleton" }
            : { ...(deepStripSecrets(env.settings) as AppSettings), id: "singleton" }
        ) as AppSettings
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
      // Keyed on `id` like every ordinary collection, and with no built-in
      // concept to respect: a chat template is always something the user
      // wrote. "duplicate" therefore does the useful thing here and mints a
      // fresh id, so importing a colleague's export next to your own keeps
      // both copies instead of silently picking one.
      await applyCollection<ChatTemplateRow>({
        rows: env.chatTemplates,
        table: db.chatTemplates,
        kind: "chatTemplates",
        opts,
        summary,
        idPrefix: "tpl",
        respectBuiltIn: false,
      })
      await applyKeyedCollection<TemplateDefinitionRow>({
        rows: env.templateDefinitions,
        table: db.templateDefinitions,
        kind: "templateDefinitions",
        opts,
        summary,
        keyOf: (row) => row.storageKey,
      })
      await applyKeyedCollection<TemplatePackageRow>({
        rows: env.templatePackages,
        table: db.templatePackages,
        kind: "templatePackages",
        opts,
        summary,
        keyOf: (row) => row.key,
      })
      await applyKeyedCollection<TemplateInstanceRecord>({
        rows: env.templateInstances,
        table: db.templateInstances,
        kind: "templateInstances",
        opts,
        summary,
        keyOf: (row) => row.id,
      })

      // Provider Profile Store documents are a referential bundle. A
      // duplicate import cannot safely rename ids without rewriting every
      // reference, so conflicts use the conservative skip behavior while
      // non-conflicting documents are still added.
      if (importedProfiles?.ok) {
        const profileOpts =
          opts.mergeStrategy === "duplicate" ? { ...opts, mergeStrategy: "skip" as const } : opts
        await applyCollection({
          rows: importedProfiles.value.providerProfiles,
          table: db.providerProfiles,
          kind: "providerProfiles",
          opts: profileOpts,
          summary,
          idPrefix: "provider",
          respectBuiltIn: false,
        })
        await applyCollection({
          rows: importedProfiles.value.deploymentProfiles,
          table: db.deploymentProfiles,
          kind: "deploymentProfiles",
          opts: profileOpts,
          summary,
          idPrefix: "deployment",
          respectBuiltIn: false,
        })
        await applyCollection({
          rows: importedProfiles.value.transportProfiles,
          table: db.transportProfiles,
          kind: "transportProfiles",
          opts: profileOpts,
          summary,
          idPrefix: "transport",
          respectBuiltIn: false,
        })
        const currentMeta = await db.profileStoreMeta.get("singleton")
        await db.profileStoreMeta.put({
          id: "singleton",
          profileVersion: (currentMeta?.profileVersion ?? 0) + 1,
          schemaVersion: PROFILE_STORE_SCHEMA_VERSION,
          migratedAt: new Date().toISOString(),
        })
      }

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

      // --- artifacts (always applied) ------------------------------------
      // Versions are applied after their artifacts so a partial failure leaves
      // history without a parent rather than a parent with no history — the
      // first is invisible, the second renders an artifact whose version list
      // silently lost entries.
      //
      // Under `duplicate` the copied artifact gets a fresh id and its versions
      // keep pointing at the original, exactly as canvas documents and their
      // versions already behave. The duplicate therefore starts with no
      // history rather than sharing the original's.
      await applyCollection({
        rows: env.artifacts,
        table: db.artifacts,
        kind: "artifacts",
        opts,
        summary,
        idPrefix: "art",
        respectBuiltIn: false,
      })
      await applyCollection({
        rows: env.artifactVersions,
        table: db.artifactVersions,
        kind: "artifactVersions",
        opts,
        summary,
        idPrefix: "artver",
        respectBuiltIn: false,
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
        rows: env.contextComments ?? env.canvasComments?.map(contextCommentRowFromCanvas),
        table: db.contextComments,
        kind: env.contextComments ? "contextComments" : "canvasComments",
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

      // Retrieval profiles are portable configuration. Encrypted canonical
      // rows keep their immutable ids because the AAD binds those ids; a
      // duplicate import therefore uses conservative skip semantics rather
      // than renaming or overwriting ciphertext under a mismatched identity.
      const retrievalOpts =
        opts.mergeStrategy === "duplicate" ? { ...opts, mergeStrategy: "skip" as const } : opts
      await applyCollection<RetrievalProfileRow>({
        rows: retrievalProfiles,
        table: db.retrievalProfiles,
        kind: "retrievalProfiles",
        opts: retrievalOpts,
        summary,
        idPrefix: "retrieval-profile",
        respectBuiltIn: false,
      })
      await applyCollection<RetrievalEncryptedContentRow>({
        rows: retrievalEncryptedContent,
        table: db.retrievalEncryptedContent,
        kind: "retrievalEncryptedContent",
        opts: retrievalOpts,
        summary,
        idPrefix: "retrieval-content",
        respectBuiltIn: false,
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

function validateRetrievalProfileRow(row: RetrievalProfileRow): RetrievalProfileRow {
  if (
    !row ||
    typeof row !== "object" ||
    row.schemaVersion !== 1 ||
    !row.id ||
    !row.fingerprint ||
    // `schemaVersion`, not `version`: the profile has never had a `version`
    // field, so this read was always `undefined` and rejected every valid
    // package that carried a retrieval profile.
    row.profile?.schemaVersion !== 1 ||
    row.profile.id !== row.id ||
    !Number.isFinite(row.createdAt) ||
    !Number.isFinite(row.updatedAt)
  ) {
    throw new Error("Retrieval profile backup row is invalid")
  }
  return {
    id: row.id,
    schemaVersion: 1,
    fingerprint: row.fingerprint,
    profile: row.profile,
    active: row.active === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function validateRetrievalEncryptedContentRow(
  row: RetrievalEncryptedContentRow
): RetrievalEncryptedContentRow {
  const allowedKinds = new Set(["canonical", "safe_projection", "evidence_excerpt"])
  if (
    !row ||
    typeof row !== "object" ||
    !row.id ||
    !row.entityType ||
    !row.entityId ||
    !row.corpusId ||
    !allowedKinds.has(row.kind) ||
    row.envelope?.version !== 1 ||
    row.envelope.algorithm !== "AES-256-GCM" ||
    !row.envelope.keyId ||
    !row.envelope.iv ||
    !row.envelope.ciphertext ||
    !row.envelope.aadHash ||
    !Number.isFinite(row.createdAt) ||
    !Number.isFinite(row.updatedAt)
  ) {
    throw new Error("Encrypted retrieval content backup row is invalid")
  }
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    corpusId: row.corpusId,
    ...(row.generationId ? { generationId: row.generationId } : {}),
    kind: row.kind,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyId: row.envelope.keyId,
      iv: row.envelope.iv,
      ciphertext: row.envelope.ciphertext,
      aadHash: row.envelope.aadHash,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
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
        // A targeted job (`project-claim-revalidate`) names the row it acts on;
        // the import remaps memory ids, so without this the restored job would
        // point at whatever previously held that id — or at nothing.
        ...(item.memoryId ? { memoryId: memoryIdMap.get(item.memoryId) ?? item.memoryId } : {}),
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
// Derived, never hand-listed: a kind added to the union but missed here used to
// be silently dropped on restore, taking the row's provenance with it.
const EVIDENCE_KINDS = new Set<string>(MEMORY_EVIDENCE_KINDS)
const JOB_KINDS = new Set<string>(MEMORY_JOB_KINDS)
const JOB_STATUSES = new Set([
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "no_output",
  "skipped",
  "failed",
  "cancelled",
  "completed",
])
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
  // Guard rather than a literal union so a new channel cannot silently be
  // dropped on import again — `selection` was, for exactly that reason.
  if (isMemorySourceChannel(value.sourceChannel)) {
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
  if (value.sensitivity === "unknown") row.sensitivity = "unknown"
  if (
    value.staleness === "unknown" ||
    value.staleness === "fresh" ||
    value.staleness === "stale" ||
    value.staleness === "expired"
  ) {
    row.staleness = value.staleness
  }
  if (
    value.trustState === "trusted" ||
    value.trustState === "untrusted" ||
    value.trustState === "quarantined"
  ) {
    row.trustState = value.trustState
  }
  if (value.confidence === null) row.confidence = null
  else if (isFiniteNumber(value.confidence) && value.confidence >= 0 && value.confidence <= 1) {
    row.confidence = value.confidence
  }
  if (value.expiresAt === null) row.expiresAt = null
  else {
    const expiresAt = optionalFiniteNumber(value.expiresAt)
    if (expiresAt !== undefined) row.expiresAt = expiresAt
  }
  for (const field of ["sourceRevision", "evidenceHash"] as const) {
    const safe = optionalIdentifier(value[field])
    if (safe) row[field] = safe
  }
  if (isRecord(value.extractor)) {
    const provider = optionalIdentifier(value.extractor.provider)
    const model = optionalIdentifier(value.extractor.model)
    const promptVersion = optionalIdentifier(value.extractor.promptVersion)
    if (provider && model && promptVersion) row.extractor = { provider, model, promptVersion }
  }
  if (isRecord(value.retrievalFeedback)) {
    const positive = value.retrievalFeedback.positive
    const negative = value.retrievalFeedback.negative
    const lastFeedbackAt = optionalFiniteNumber(value.retrievalFeedback.lastFeedbackAt)
    if (isFiniteNumber(positive) && positive >= 0 && isFiniteNumber(negative) && negative >= 0) {
      row.retrievalFeedback = {
        positive,
        negative,
        ...(lastFeedbackAt !== undefined ? { lastFeedbackAt } : {}),
      }
    }
  }
  if (typeof value.scopeRationale === "string") {
    const scopeRationale = redactText(value.scopeRationale).redacted.trim()
    if (scopeRationale && hasNoLeakingPii(scopeRationale)) row.scopeRationale = scopeRationale
  }
  if (Array.isArray(value.conflictWithIds)) {
    row.conflictWithIds = value.conflictWithIds.flatMap((item) => {
      const safe = optionalIdentifier(item)
      return safe ? [safe] : []
    })
  }
  const invalidatedAt = optionalFiniteNumber(value.invalidatedAt)
  if (invalidatedAt !== undefined) row.invalidatedAt = invalidatedAt
  // Project-claim descriptors travel; the validation verdict does not. See the
  // matching note in `sanitizeImportedEvidence` — `validatedAt` is a claim about
  // sources that may not have come with this package, so it is left unset and
  // re-derived by the re-check sweep.
  if (isProjectMemoryKind(value.projectMemoryKind)) {
    row.projectMemoryKind = value.projectMemoryKind
  }
  const observedAt = optionalFiniteNumber(value.observedAt)
  if (observedAt !== undefined) row.observedAt = observedAt
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
    ...(value.sourceRole === "user" ||
    value.sourceRole === "assistant" ||
    value.sourceRole === "tool" ||
    value.sourceRole === "system"
      ? { sourceRole: value.sourceRole }
      : {}),
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
    // Descriptive fields travel; VERDICTS do not. `validationState` and
    // `validatedAt` say "we checked this against the messages on that machine at
    // that moment", which a restore cannot vouch for — a partial or merged
    // import can easily land a claim whose sources did not come with it. Leaving
    // them unset means the row reads as `"unvalidated"` and the re-check sweep
    // re-derives the truth against whatever actually got restored, instead of
    // this claim being injected at full support on an imported promise.
    ...(isMemoryValidationStrategy(value.validationStrategy)
      ? { validationStrategy: value.validationStrategy }
      : {}),
    ...(optionalFiniteNumber(value.sourceRevision) !== undefined
      ? { sourceRevision: optionalFiniteNumber(value.sourceRevision) }
      : {}),
  }
}

/**
 * Validate a `MemoryJobCheckpoint` sub-object field by field.
 *
 * Dropping it on import is not neutral: without a checkpoint the job falls back
 * to the legacy trailing-`:<n>` of its dedupe key, which resolves to a message
 * COUNT rather than an id window. Every dedupe key this codebase writes still
 * ends in that count, so the fallback stays correct — but a partially-valid
 * checkpoint must never survive, or the job would resolve against ids that were
 * never verified.
 */
function sanitizeImportedJobCheckpoint(value: unknown): MemoryJobCheckpoint | undefined {
  if (!isRecord(value)) return undefined
  const firstMessageId = optionalIdentifier(value.firstMessageId)
  const lastMessageId = optionalIdentifier(value.lastMessageId)
  const transcriptRevision = optionalFiniteNumber(value.transcriptRevision)
  const messageCount = optionalFiniteNumber(value.messageCount)
  if (
    !firstMessageId ||
    !lastMessageId ||
    transcriptRevision === undefined ||
    transcriptRevision < 0 ||
    messageCount === undefined ||
    !Number.isSafeInteger(messageCount) ||
    messageCount <= 0
  ) {
    return undefined
  }
  return { transcriptRevision, firstMessageId, lastMessageId, messageCount }
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
    status: (value.status === "completed" ? "succeeded" : value.status) as MemoryJob["status"],
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
    "agentId",
    "memoryId",
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
  for (const field of [
    "heartbeatAt",
    "attempt",
    "maxAttempts",
    "cancellationRequestedAt",
  ] as const) {
    const safe = optionalFiniteNumber(value[field])
    if (safe !== undefined) row[field] = safe
  }
  const resultCode = optionalIdentifier(value.resultCode)
  if (resultCode) row.resultCode = resultCode
  const checkpoint = sanitizeImportedJobCheckpoint(value.checkpoint)
  if (checkpoint) row.checkpoint = checkpoint
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
