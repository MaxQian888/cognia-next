// IndexedDB schema (via Dexie) for chat sessions, messages, and app settings.
// Keep version numbers strictly increasing when adding tables/indexes.

import Dexie, { type Table } from "dexie"
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
} from "@/lib/claude/types"
import type { TrustedWorkspace } from "./trusted-workspaces"
import type { BackupHistoryRow } from "./backup-history"
import type {
  CanvasDocumentRow,
  CanvasVersionRow,
  CanvasCommentRow,
  CanvasSessionRow,
} from "./canvas-types"
import type { A2UIAppRow, A2UISurfaceRow, A2UITemplateRow, A2UIEventHistoryRow } from "./a2ui-types"
import { buildA2UIBridgeMcpRow, A2UI_BRIDGE_SERVER_NAME } from "@/lib/a2ui/mcp-tool-schemas"
import type { TwinSource, TwinChunk, TwinProfile, TwinDraft, TwinJob } from "@/types/twin"

export class CogniaDB extends Dexie {
  sessions!: Table<ChatSession, string>
  messages!: Table<StoredMessage, string>
  settings!: Table<AppSettings, "singleton">
  promptPresets!: Table<SystemPromptPreset, string>
  mcpServers!: Table<McpServer, string>
  characters!: Table<Character, string>
  skills!: Table<Skill, string>
  skillResources!: Table<SkillResource, string>
  teams!: Table<Team, string>
  trustedWorkspaces!: Table<TrustedWorkspace, string>
  backupHistory!: Table<BackupHistoryRow, string>
  canvasDocuments!: Table<CanvasDocumentRow, string>
  canvasVersions!: Table<CanvasVersionRow, string>
  canvasComments!: Table<CanvasCommentRow, string>
  canvasSessions!: Table<CanvasSessionRow, string>
  a2uiApps!: Table<A2UIAppRow, string>
  a2uiSurfaces!: Table<A2UISurfaceRow, string>
  a2uiTemplates!: Table<A2UITemplateRow, string>
  a2uiEventHistory!: Table<A2UIEventHistoryRow, string>
  twinSources!: Table<TwinSource, string>
  twinChunks!: Table<TwinChunk, string>
  twinProfile!: Table<TwinProfile, string>
  twinDrafts!: Table<TwinDraft, string>
  twinJobs!: Table<TwinJob, string>

  constructor() {
    super("cognia-claude")

    this.version(1).stores({
      sessions: "id, updatedAt, createdAt",
      messages: "id, sessionId, [sessionId+createdAt]",
      settings: "id",
    })

    // v2 — adds prompt presets and MCP server tables. No upgrade hook needed
    // because we're only adding new stores; existing data is untouched.
    this.version(2).stores({
      sessions: "id, updatedAt, createdAt",
      messages: "id, sessionId, [sessionId+createdAt]",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
    })

    // v3 — characters, skills, teams. Extend session/message indexes for the
    // new lookups (kind/characterId/teamId on sessions, senderId on messages).
    // Built-in seeds are populated on first access via `lib/db/seed.ts`, not
    // in an upgrade hook, so the seeding stays robust across reloads and
    // doesn't fight Dexie's own migration transaction.
    this.version(3).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
    })

    // v4 — sessionState (unread / last-read tracking). Kept separate from the
    // session row so the immutable session metadata isn't churned every time
    // a message arrives.
    this.version(4).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
    })

    // v5 — Team.memberCharacterIds (string[]) → Team.members (TeamMember[]).
    // Indexes are unchanged; only the row shape for `teams` changes. The
    // upgrade hook is idempotent: if a row already has `members[]`, leave it.
    this.version(5)
      .stores({
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets: "id, updatedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("teams")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (Array.isArray(row.members)) return
            const ids = Array.isArray(row.memberCharacterIds)
              ? (row.memberCharacterIds as string[])
              : []
            row.members = ids.map((characterId) => ({ characterId }))
            delete row.memberCharacterIds
          })
      })

    // v6 — adds `trustedWorkspaces` for the workspace-trust gate that hooks
    // and project-scoped slash commands consult before running. Pure new
    // table; no upgrade hook needed.
    this.version(6).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
    })

    // v7 — McpServer.appsEnabled: per-agent projection toggles for the
    // multi-agent sync feature (Claude Code / Cursor / VS Code / Codex /
    // Gemini / Windsurf / etc.). Indexes unchanged. The upgrade hook
    // back-fills `{}` for legacy rows so reads don't have to defend against
    // `undefined`; sync code treats the empty object as "not projected
    // anywhere yet".
    this.version(7)
      .stores({
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets: "id, updatedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
        trustedWorkspaces: "path, trustedAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("mcpServers")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.appsEnabled && typeof row.appsEnabled === "object") return
            row.appsEnabled = {}
          })
      })

    // v8 — Skills feature port: adds the `skillResources` table for bundled
    // scripts/refs/assets, and richer indexes on `skills` (category / source
    // / status / lastUsedAt) so the panel UI can filter without scanning the
    // full collection. Existing rows get default values back-filled in the
    // upgrade hook so the new filter dropdowns don't show "(empty)" buckets.
    this.version(8)
      .stores({
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets: "id, updatedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
        skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
        trustedWorkspaces: "path, trustedAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("skills")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (!row.source) {
              row.source = row.isBuiltIn ? "builtin" : "custom"
            }
            if (!row.status) row.status = "enabled"
            if (!row.category) row.category = row.isBuiltIn ? "meta" : "custom"
            if (typeof row.usageCount !== "number") row.usageCount = 0
          })
      })

    // v9 — TTS provider key fallback table (web mode only). Tauri builds use
    // the OS keyring; this table is consulted only when `isTauri()` is false
    // so the user can still configure cloud providers in the browser shell.
    this.version(9).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
    })

    // v10 — `backupHistory` for the data-section's history card. Pure new
    // table; no upgrade hook needed. Indexed by `completedAt` so the panel
    // can sort newest-first with `db.backupHistory.orderBy("completedAt").reverse()`,
    // and by `type` / `success` so we can filter to only auto-backups or
    // failures without scanning the whole table.
    this.version(10).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
    })

    // v11 — Canvas (Monaco-based code/document editor) tables. Pure new
    // tables; no upgrade hook needed. Documents are the primary records;
    // versions/comments/sessions hang off documentId for cascade deletes
    // performed at the CRUD layer (lib/db/canvas-documents.ts).
    this.version(11).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
    })

    // v12 — Preset feature uplift. Existing 5-field rows survive untouched;
    // the upgrade hook back-fills `isBuiltIn=false`, `isFavorite=false`,
    // `usageCount=0`, `sortOrder=0` so newly-added filters/sort indexes don't
    // see "(empty)" buckets. Indexes for the rich-preset section: category
    // (filter chips), sortOrder (manual reorder), lastUsedAt ("Recent" filter),
    // isDefault / isFavorite / isBuiltIn (badge queries). IndexedDB doesn't
    // index booleans reliably across browsers — these flags are stored as-is
    // (no 1/0 coercion) and filtered in memory by the CRUD layer.
    this.version(12)
      .stores({
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets:
          "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
        skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
        trustedWorkspaces: "path, trustedAt",
        tts_provider_keys: "id",
        backupHistory: "id, completedAt, type, success",
        canvasDocuments: "id, title, language, type, updatedAt, createdAt",
        canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
        canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
        canvasSessions: "id, documentId, ownerId, createdAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("promptPresets")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.isBuiltIn === undefined) row.isBuiltIn = false
            if (row.isFavorite === undefined) row.isFavorite = false
            if (row.usageCount === undefined) row.usageCount = 0
            if (row.sortOrder === undefined) row.sortOrder = 0
          })
      })

    // v13 — A2UI subsystem tables + the in-process `a2ui-bridge` MCP server
    // row. The new tables are pure additions; characters get an
    // `a2uiEnabled = false` backfill so prompts don't grow until the user
    // explicitly opts in. The MCP row is seeded idempotently by name so
    // re-running the upgrade (test resets, schema rollbacks) is safe.
    this.version(13)
      .stores({
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets:
          "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
        skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
        trustedWorkspaces: "path, trustedAt",
        tts_provider_keys: "id",
        backupHistory: "id, completedAt, type, success",
        canvasDocuments: "id, title, language, type, updatedAt, createdAt",
        canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
        canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
        canvasSessions: "id, documentId, ownerId, createdAt",
        a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
        a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
        a2uiTemplates: "id, name, category, updatedAt, source",
        a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      })
      .upgrade(async (tx) => {
        await tx
          .table("characters")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.a2uiEnabled === undefined) row.a2uiEnabled = false
          })
        const exists = await tx
          .table("mcpServers")
          .where("name")
          .equals(A2UI_BRIDGE_SERVER_NAME)
          .first()
        if (!exists) {
          await tx.table("mcpServers").add(buildA2UIBridgeMcpRow())
        }
      })

    // v14 — Employee Digital Twin tables. Pure additions (no upgrade hook
    // required): the only existing-row migration is the `Character.twinId` /
    // `Character.twinSettings` fields, both of which are TS-optional and
    // schema-less in Dexie (non-indexed) — old rows simply omit them.
    //
    // Indexes are picked for the hot paths the Phase 4-7 code drives:
    //   • `twinSources`  — by twinId+kind/status to power the workbench source
    //                      list, by `fingerprint` for dedupe-on-import.
    //   • `twinChunks`   — by twinId+sourceId for cascade-delete and source
    //                      drilldown, by `vectorDocId` to resolve a vector
    //                      search hit back to its full-text payload.
    //   • `twinProfile`  — 1:1 with twinId; only the lookup index is needed.
    //   • `twinDrafts`   — by twinId+status to render the "needs review"
    //                      queue, by twinId+kind to filter character vs skill.
    //   • `twinJobs`     — by twinId+status for "in-flight" badges; by
    //                      `queuedAt` to drive a FIFO scheduler picker.
    this.version(14).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
    })
  }

  sessionState!: Table<SessionStateRow, string>
  tts_provider_keys!: Table<TtsProviderKeyRow, string>
}

/** Web-mode fallback row for TTS provider API keys. */
export interface TtsProviderKeyRow {
  /** "tts.providerKey.<provider>" */
  id: string
  value: string
}

/**
 * Per-session unread tracking. Only sessions the user has actually opened
 * have a row here; everything else is treated as unread = 0.
 */
export interface SessionStateRow {
  sessionId: string
  lastReadAt: number
  unreadCount: number
}

let _db: CogniaDB | null = null
let _seedPromise: Promise<void> | null = null

export function getDb(): CogniaDB {
  // SSR-safe: only instantiate Dexie on the client. Static export still
  // pre-renders pages where `window` is undefined, so we lazy-create.
  if (typeof window === "undefined") {
    throw new Error("getDb() called on the server — wrap usage in a client component")
  }
  if (!_db) {
    _db = new CogniaDB()
    // Kick off seeding once per process. We import lazily to avoid a circular
    // dependency: seed.ts imports the per-table CRUD modules which import this
    // file. The promise is memoized so concurrent callers share the same run.
    _seedPromise = import("./seed")
      .then(({ seedBuiltIns }) => seedBuiltIns())
      .catch((err) => {
        // DatabaseClosedError fires when the db is deleted out from under us
        // (common during tests and hard resets). Not actionable; suppress.
        const name = err instanceof Error ? err.name : ""
        if (name === "DatabaseClosedError" || name === "DatabaseClosed") return
        console.error("seedBuiltIns failed", err)
      })
  }
  return _db
}

/**
 * Resolves once the built-in characters/skills/teams have been seeded. UI
 * surfaces that need to render seed rows immediately (the character picker on
 * first launch) can `await` this; everywhere else `useLiveQuery` will pick up
 * the rows reactively as soon as the seed completes.
 */
export function whenSeeded(): Promise<void> {
  // Touch getDb to ensure seeding has been kicked off.
  getDb()
  return _seedPromise ?? Promise.resolve()
}

/**
 * Test-only: drop the cached Dexie instance so the next `getDb()` call
 * re-opens a fresh database. Use after `db.delete()` in `beforeEach` blocks
 * — production code must never call this.
 */
export function __resetDbForTesting(): void {
  _db = null
  _seedPromise = null
}
