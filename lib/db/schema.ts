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
import type { MobileOutboundJobRow } from "./mobile-outbound-types"
import type {
  PluginRow,
  PluginPermissionRow,
  PluginReviewRow,
  PluginAnalyticsRow,
  PluginScheduledJobRow,
} from "./plugin-types"
import type { WikiArticle, WikiSection, WikiManifest, McpAuditLogRow } from "@/types/wiki"
import type { SubscriptionUsageRow } from "@/lib/anthropic-subscription/types"
import type {
  AdapterInstanceRow,
  PlatformIdentityRow,
  InboundLedgerRow,
  OutboundJobRow,
  ConversationOverrideRow,
  ConnectorAuditRow,
  ConnectorDraftRow,
  ConnectorAttachmentRow,
} from "./connector-types"
import type {
  WorkflowRow,
  WorkflowRunRow,
  WorkflowRunEventRow,
  WorkflowTriggerRow,
} from "@/types/workflow/visual"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { SessionUsageRow } from "./session-usage"
import type { ChatDraftRow } from "./chat-drafts"

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
  // §A-Schema (v15) — plugin tables. Indexed columns are declared in the v15
  // .stores block below; the per-row types live in `./plugin-types.ts`.
  plugins!: Table<PluginRow, string>
  pluginPermissions!: Table<PluginPermissionRow, [string, string]>
  pluginReviews!: Table<PluginReviewRow, [string, string]>
  pluginAnalytics!: Table<PluginAnalyticsRow, [string, string]>
  pluginScheduledJobs!: Table<PluginScheduledJobRow, string>
  // v17 — External Bridge (LLM Wiki) tables. Wiki articles are addressed by
  // slug (unique within scope); the manifest is keyed by `scope` so each
  // (scope, build) pair is one row. The audit log is capped at 5000 newest
  // rows by `lib/db/mcp-audit-log.ts`.
  wikiArticles!: Table<WikiArticle, string>
  wikiSections!: Table<WikiSection, string>
  wikiManifest!: Table<WikiManifest, string>
  mcpAuditLog!: Table<McpAuditLogRow, string>
  // v18 — Platform Connectors tables. Indexed columns are declared in the v18
  // .stores block below; the per-row types live in `./connector-types.ts`.
  adapterInstances!: Table<AdapterInstanceRow, string>
  platformIdentities!: Table<PlatformIdentityRow, string>
  inboundLedger!: Table<InboundLedgerRow, string>
  outboundQueue!: Table<OutboundJobRow, string>
  conversationOverrides!: Table<ConversationOverrideRow, string>
  connectorAudit!: Table<ConnectorAuditRow, string>
  connectorDrafts!: Table<ConnectorDraftRow, string>
  connectorAttachments!: Table<ConnectorAttachmentRow, string>
  // v20 — Claude subscription usage table. One row per `anthropic-ratelimit-
  // unified-*` header snapshot; capped at 1 000 rows newest-first by
  // `lib/anthropic-subscription/usage-collector.ts`.
  subscriptionUsage!: Table<SubscriptionUsageRow, number>
  // v22 — Visual workflows subsystem (n8n-style). The `workflows` table holds
  // user-authored definitions; `workflowRuns` is one row per execution with
  // a frozen snapshot of the def at run start; `workflowRunEvents` is the
  // durable per-step event log live-queried by the editor + Runs UI;
  // `workflowTriggers` holds registered triggers (cron, webhook, inbound,
  // chat-message, ...) that wake workflows. Run-state mirroring for crash
  // recovery happens in a separate SQLite DB managed by Rust — Dexie is the
  // source of truth for definitions and the event log.
  workflows!: Table<WorkflowRow, string>
  workflowRuns!: Table<WorkflowRunRow, string>
  workflowRunEvents!: Table<WorkflowRunEventRow, string>
  workflowTriggers!: Table<WorkflowTriggerRow, string>
  // v23 — Mobile companion paired devices (ADR 0012 → M2). One row per phone
  // that completed the QR pairing flow (POST /api/v1/auth/pair, M2.3). The
  // owner can soft-delete (revoke) any row from the desktop's "Mobile
  // companion" settings tab; the JWT verifier middleware (M2.4) keeps an
  // in-memory deny-list mirror of revoked rows. Per-row types live in
  // `@/types/mobile/paired-device.ts`; CRUD helpers in `./paired-devices.ts`.
  pairedDevices!: Table<PairedDeviceRow, string>
  // v24 — Per-message usage + cost rows captured by the SDK adapter on each
  // `result` event. Primary key `messageId` is the Anthropic assistant
  // message id, which is unique across all sessions, so the writer is
  // naturally idempotent. Aggregation helpers + UI consumers live in
  // `./session-usage.ts` and `components/settings/agent-runtime/tabs/sessions-tab.tsx`.
  sessionUsage!: Table<SessionUsageRow, string>
  // v25 — Mobile outbound queue (Wave 2.1, ADR-0015 §Wave 2). One row per
  // write op enqueued from the phone (chat send, draft approval, workflow
  // trigger, twin ingest, backup export). The runner in
  // `lib/queue/outbound-queue.ts` drains pending rows when the network is
  // online; failed rows back off exponentially and deadletter at 5 attempts.
  mobileOutboundQueue!: Table<MobileOutboundJobRow, string>
  // v26 — Per-session unsent composer text (chat drafts). Pure additive, no
  // upgrade hook. Primary key `sessionId` makes upserts trivial; `updatedAt`
  // is indexed so debug surfaces can sort newest-first.
  chatDrafts!: Table<ChatDraftRow, string>
  // v27 — plugin Dexie table registry (M0 platform feature).
  pluginDexieMeta!: Table<PluginDexieMeta, string>
  // v28 — UI automation audit log. One row per Tauri command call that
  // passes through the Rust permission gate. Capped at 5000 newest by
  // `lib/automation/audit.ts`. Indexed by `ts` for newest-first listings,
  // `surface` so the Settings → Automation → Audit tab can filter, and
  // `decision` for the deny-only view.
  automationAuditLog!: Table<AutomationAuditLogRow, string>
  // v29 — WASM plugin author keys the user has trusted (Ed25519 public keys
  // from manifest.author.publicKey, base64). First install of a signed
  // plugin from HTTP/Git prompts the user with the key fingerprint; on
  // accept a row is inserted here so future updates from the same author
  // auto-trust. Pure additive table.
  trustedPublishers!: Table<TrustedPublisherRow, string>

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

    // v15 — Plugin system port. Adds 5 plugin-related tables; existing rows
    // are untouched so no upgrade hook is needed. Indexes mirror Cognia's
    // production schema:
    //   * `plugins` — single-key + status/source/type filters for the
    //     Settings → Plugins list, `lastUsedAt` for "recent" sort, `enabled`
    //     for the activation gate, `*capabilities` (multi-entry) so the
    //     "filter by capability" dropdown stays index-driven.
    //   * `pluginPermissions` — composite primary key on (pluginId, permission)
    //     so the runtime can look up a single decision in O(1) without scanning.
    //     Side indexes on `pluginId` / `permission` / `decision` / `expiresAt`
    //     drive the audit-log UI and TTL sweep.
    //   * `pluginReviews` — composite primary key on (pluginId, id) lets a
    //     single plugin carry many reviews; `rating` and `createdAt` for the
    //     marketplace-tab sorts.
    //   * `pluginAnalytics` — composite primary key on (pluginId, key) so
    //     each (plugin, metric) row is unique and `lastEventAt` indexes
    //     the "recent activity" sort.
    //   * `pluginScheduledJobs` — single-key + `pluginId` / cron / status /
    //     run-time filters so the scheduler executor can pull only the
    //     active rows it needs.
    //
    // The new tables are empty for existing v14 installs; the migration test
    // (Phase 1 verification) asserts every prior row survives the upgrade.
    this.version(15).stores({
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
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
    })

    // v16 — Dual-variant CustomTheme migration. The settings table schema
    // itself doesn't change between v15 and v16 — `customThemes` is a
    // JSON-typed field inside the singleton row, not its own table. The
    // upgrade hook walks each theme and rewrites the legacy `{colors, isDark}`
    // pair to `{tokens: {light, dark}, baseVariant, derivedVariant}`,
    // deriving the opposite variant via OKLCH math (Task 6 — `deriveOppositeVariant`).
    //
    // The legacy fields are preserved on each row for one release so a
    // rollback to v15 doesn't lose data. They will be pruned in a future
    // version once the dual-variant shape has been live for at least one
    // release cycle. The hook is idempotent — already-migrated rows
    // (those with `tokens.light` populated) are skipped.
    this.version(16)
      .stores({
        // SAME as v15. The settings table schema doesn't change; only the
        // blob shape inside the singleton row does.
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
        twinSources:
          "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
        twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
        twinProfile: "&id, twinId",
        twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
        twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
        plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
        pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
        pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
        pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
        pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
      })
      .upgrade(async (tx) => {
        // Lazy-import to avoid loading the OKLCH derivation code (and its
        // ~25 KB culori dep) on the cold path of every db open. Most users
        // never hit this branch — the import only fires during the one-time
        // upgrade transaction.
        const { deriveOppositeVariant } = await import("@/lib/appearance/derive-variant")
        await tx
          .table("settings")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const themes = (row.customThemes ?? []) as Array<Record<string, unknown>>
            for (const t of themes) {
              // Idempotent: skip rows that have already been migrated.
              if (t.tokens && (t.tokens as { light?: unknown }).light) continue
              if (!t.colors) continue
              const baseVariant: "light" | "dark" = t.isDark ? "dark" : "light"
              const opposite: "light" | "dark" = baseVariant === "dark" ? "light" : "dark"
              const single = t.colors as Record<string, string>
              t.baseVariant = baseVariant
              t.derivedVariant = opposite
              // The legacy `colors` blob is `Partial<ThemeColors>` — older
              // rows may have missing keys. `deriveOppositeVariant` walks
              // `Object.entries(source)` so it handles partial inputs without
              // surfacing `undefined` keys; cast through `unknown` to bypass
              // the strict `ThemeColors` shape check.
              t.tokens = {
                [baseVariant]: single,
                [opposite]: deriveOppositeVariant(
                  single as unknown as Parameters<typeof deriveOppositeVariant>[0],
                  baseVariant
                ),
              }
              // Preserve `colors` and `isDark` for one release for rollback safety.
            }
          })
      })

    // v17 — External Bridge (LLM Wiki + MCP server) tables. Pure additions;
    // no upgrade hook needed (existing rows aren't touched). Indexes match the
    // hot paths in `lib/external-bridge/handlers/*` and `lib/wiki/*`:
    //   • `wikiArticles`  — `&slug` is unique within table (we treat the
    //     slug as the primary lookup key, but use a separate `id` so we can
    //     reuse Dexie's `id` convention from twin tables); `[scope+module]`
    //     drives `wiki_search` filter; `pageRank` is a tie-breaker but
    //     hybrid scoring runs in memory.
    //   • `wikiSections`  — by `articleId` for partial reload; `[articleId+sectionIndex]`
    //     for in-order render.
    //   • `wikiManifest`  — keyed by `scope` (one row per scope).
    //   • `mcpAuditLog`   — by `ts` for newest-first listing; `tool` for
    //     filter; `allowed` for "show only denied" view in Settings.
    this.version(17).stores({
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
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
      wikiArticles: "&id, &slug, scope, module, pageRank, generatedAt, [scope+module]",
      wikiSections: "&id, articleId, [articleId+sectionIndex]",
      wikiManifest: "&scope, lastBuildAt",
      mcpAuditLog: "&id, ts, tool, allowed, [tool+ts]",
    })

    // v18 — Platform Connectors (ADR-0009). Pure additions; no upgrade hook
    // because we don't migrate existing rows. Indexes calibrated to the
    // hot paths in lib/connectors/:
    //   • adapterInstances — by enabled/type for the bus boot list, by displayName for nav.
    //   • platformIdentities — composite [platform+remoteUserId] for cross-platform
    //     identity merge, [adapterId+remoteUserId] for per-adapter directory lookups.
    //   • inboundLedger — composite [adapterId+platformMessageId] for O(1) dedup
    //     check; receivedAt for the LRU prune sweep (cap 10k rows).
    //   • outboundQueue — by conversationKey for FIFO lane lookup, by [conversationKey+createdAt]
    //     for in-order picking, by status / nextAttemptAt for the runner's
    //     "next pending due" query, by idempotencyKey for retry coalescing.
    //   • conversationOverrides — by conversationKey for resolution, by sessionId
    //     for "session → override" lookups when the chat UI binds.
    //   • connectorAudit — by adapterId for per-adapter filter, by [adapterId+at]
    //     for time-ordered scrolling. Capped at 5000 rows by the writer.
    //   • connectorDrafts — by conversationKey + status for "next pending draft",
    //     by [conversationKey+createdAt] for order.
    //   • connectorAttachments — composite [adapterId+remoteRef] for "do I have it",
    //     by adapterId for adapter-scoped cleanup, by mimeType for filters.
    this.version(18).stores({
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
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
      wikiArticles: "&id, &slug, scope, module, pageRank, generatedAt, [scope+module]",
      wikiSections: "&id, articleId, [articleId+sectionIndex]",
      wikiManifest: "&scope, lastBuildAt",
      mcpAuditLog: "&id, ts, tool, allowed, [tool+ts]",
      adapterInstances: "id, type, enabled, displayName, [type+enabled], createdAt, updatedAt",
      platformIdentities:
        "&id, [platform+remoteUserId], [adapterId+remoteUserId], remoteUserId, platform, lastSeenAt",
      inboundLedger: "&id, [adapterId+platformMessageId], adapterId, receivedAt",
      outboundQueue:
        "&id, conversationKey, [conversationKey+createdAt], status, nextAttemptAt, idempotencyKey, [adapterId+status]",
      conversationOverrides: "&id, &conversationKey, sessionId, pinned, archived",
      connectorAudit: "&id, adapterId, kind, at, [adapterId+at]",
      connectorDrafts:
        "&id, conversationKey, sessionId, [conversationKey+createdAt], status, expiresAt",
      connectorAttachments: "&id, [adapterId+remoteRef], adapterId, mimeType, fetchedAt, expiresAt",
    })

    // v19 — Pure index addition: `conversationOverrides` now has `updatedAt`
    // indexed so the Conversations settings tab can drive a `orderBy("updatedAt")`
    // newest-first listing. No upgrade hook needed; existing rows already carry
    // `updatedAt` (set by `lib/db/conversation-overrides.ts`), Dexie just needs
    // the keyPath registered on the object store.
    this.version(19).stores({
      conversationOverrides: "&id, &conversationKey, sessionId, pinned, archived, updatedAt",
    })

    // v20 — Claude subscription usage. One row per snapshot of the
    // `anthropic-ratelimit-unified-*` headers, captured either passively from
    // real chat traffic or actively from the optional probe loop. The collector
    // trims oldest rows over the 1 000-row cap; the Overview / Usage tabs query
    // by `[fetchedAt+source]` for time-windowed views.
    this.version(20).stores({
      subscriptionUsage: "++localId, fetchedAt, status, source, [source+fetchedAt]",
    })

    // v21 — Pure index addition: `outboundQueue` now has `createdAt` indexed
    // standalone so the Outbound settings tab can drive a global newest-first
    // listing via `orderBy("createdAt").reverse()`. The existing
    // `[conversationKey+createdAt]` compound index only supports per-lane
    // ordering and Dexie rejects a standalone `orderBy("createdAt")` against
    // it ("KeyPath createdAt … is not indexed"). No upgrade hook needed —
    // existing rows already carry `createdAt` (set by the writer), Dexie just
    // needs the keyPath registered on the object store.
    this.version(21).stores({
      outboundQueue:
        "&id, conversationKey, [conversationKey+createdAt], status, nextAttemptAt, idempotencyKey, [adapterId+status], createdAt",
    })

    // v22 — Visual workflows (ADR-0011). Pure additions; no upgrade hook
    // because we don't migrate existing rows (no prior workflow data exists).
    // Indexes are calibrated to the hot paths in lib/workflow/ and components/workflow/:
    //   • workflows         — &id is the primary; `name` for the library list
    //                         orderBy("name"), `updatedAt` for "Recently edited",
    //                         `isBuiltIn` / `isTemplate` for the gallery filters,
    //                         `*tags` (multi-entry) for tag-driven discovery,
    //                         `schemaVersion` so the migrator can pick out
    //                         legacy rows without scanning the blob.
    //   • workflowRuns      — &id primary; per-workflow filtering + sort uses
    //                         [workflowId+startedAt] (timeline) and
    //                         [workflowId+status] (status-filter chips). The
    //                         standalone `status` index drives the global
    //                         "Recent runs" tab; `startedAt` is also indexed
    //                         standalone so the same tab can sort newest-first
    //                         across all workflows.
    //   • workflowRunEvents — &id primary; the per-step timeline binds to
    //                         [runId+ts] for in-order render and [runId+stepId]
    //                         to scroll/highlight a specific node's events.
    //                         `type` is indexed for the "errors only" filter.
    //   • workflowTriggers  — &id primary; [workflowId+enabled] is the lookup
    //                         the editor uses to render the trigger pane; the
    //                         standalone `kind` and `cron` indexes power the
    //                         Settings → Defaults overview without scans.
    //                         `nextFireAt` is indexed so the cron preview
    //                         (TS-side) can list the next N firings cheaply
    //                         without re-evaluating every cron expression.
    this.version(22).stores({
      workflows: "&id, name, updatedAt, createdAt, isBuiltIn, isTemplate, *tags, schemaVersion",
      workflowRuns:
        "&id, workflowId, status, startedAt, completedAt, [workflowId+startedAt], [workflowId+status]",
      workflowRunEvents: "&id, runId, [runId+ts], stepId, [runId+stepId], type",
      workflowTriggers: "&id, workflowId, kind, enabled, [workflowId+enabled], cron, nextFireAt",
    })

    // v23 — Mobile companion paired devices. Pure additive; no upgrade hook
    // because no prior pairedDevices data exists. Indexes: `lastSeenAt` for
    // the settings table's newest-first sort and `revokedAt` so the deny-list
    // cache (M2.4) can hydrate from a `where("revokedAt").above(0)` query at
    // server boot without scanning the full table.
    this.version(23).stores({
      pairedDevices: "&deviceId, lastSeenAt, revokedAt, platform",
    })

    // v24 — Per-turn usage + cost rows. Pure additive, no upgrade hook.
    //   • `&messageId`        — primary key (Anthropic assistant message id,
    //                            unique across sessions). put() is idempotent.
    //   • `sessionId`         — equality lookup for per-session aggregations
    //                            and cascade delete in `deleteSession`.
    //   • `[sessionId+at]`    — used by the chat header / sessions tab to
    //                            render rows in chronological order without
    //                            an in-memory sort.
    //   • `at`                — global newest-first listing (audit / debug).
    //   • `model`             — power the per-model breakdown popover.
    this.version(24).stores({
      sessionUsage: "&messageId, sessionId, [sessionId+at], at, model, characterId",
    })

    // v25 — Mobile outbound queue (Wave 2.1, ADR-0015 §Wave 2). Indexes:
    //   • `&id`             — UUIDv4 primary key.
    //   • `status`           — claimNext + listByStatus filter.
    //   • `[status+nextAttemptAt]` — runner picks the next ready row by
    //                          (status="pending", nextAttemptAt <= now).
    //   • `createdAt`        — chronological listing in the queue UI.
    //   • `command`          — "show only chat sends" filters in deadletter view.
    this.version(25).stores({
      mobileOutboundQueue: "&id, status, [status+nextAttemptAt], createdAt, command",
    })

    // v26 — Per-session chat composer drafts (unsent text). Pure additive.
    //   • `&sessionId`  — primary key; upsert by sessionId so each session has
    //                     at most one draft row.
    //   • `updatedAt`   — newest-first listing for debug / data settings.
    this.version(26).stores({
      chatDrafts: "&sessionId, updatedAt",
    })

    // v27 — Plugin Dexie table registry (M0 platform feature).
    //   Tracks which dynamic schema versions have been applied per plugin so
    //   that applyPluginTables can compute the next Dexie version number
    //   without a full db.tables scan, and so that removePluginTables knows
    //   which namespaced table names to drop.
    //   • `&pluginId`   — primary key; one row per plugin.
    //   • `appliedAt`   — debug/audit timestamp.
    this.version(27).stores({
      pluginDexieMeta: "&pluginId, appliedAt",
    })

    // v28 — UI automation audit log. Mirrors `mcpAuditLog` in shape: one row
    // per Rust-side permission-gate evaluation (allow/deny/consent). Cap is
    // enforced in `lib/automation/audit.ts:recordEntry`, not in the schema.
    //   • `&id`         — uuid primary key.
    //   • `ts`          — newest-first listing.
    //   • `surface`     — workflow / computerUse / mcp / plugin filter.
    //   • `decision`    — allow / deny / consent filter (for the "deny only" view).
    //   • `command`     — drill-down by Tauri command name.
    this.version(28).stores({
      automationAuditLog: "&id, ts, surface, decision, command",
    })

    // v29 — Trusted publisher ledger for WASM plugin signed installs.
    //   • `&publicKey`  — base64-encoded Ed25519 public key (primary key
    //                     guarantees one row per author key).
    //   • `fingerprint` — SHA-256 hex of the key for fast lookup in the UI.
    //   • `firstTrustedAt` — epoch ms of first install accept.
    this.version(29).stores({
      trustedPublishers: "&publicKey, fingerprint, firstTrustedAt",
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

/**
 * One row per automation Tauri command call. Mirror of
 * `src-tauri/src/automation/audit.rs:AuditEntry` (camelCase wire format).
 * Written by the `automation:event` subscriber in `lib/automation/audit.ts`.
 */
export interface AutomationAuditLogRow {
  id: string
  ts: number
  surface: "workflow" | "computerUse" | "mcp" | "plugin"
  pluginId: string | null
  command: string
  processName: string | null
  windowTitle: string | null
  decision: "allow" | "deny" | "consent"
  reason: string | null
  durationMs: number
  error: string | null
}

/** Registry entry for a plugin's declared Dexie tables. Written by applyPluginTables. */
export interface PluginDexieMeta {
  /** Primary key — the plugin's id. */
  pluginId: string
  /** Namespaced table names currently registered for this plugin. */
  tableNames: string[]
  /** The Dexie db version at which these tables were last registered. */
  dexieVersion: number
  appliedAt: number
}

/**
 * Trusted plugin publisher ledger — one row per Ed25519 public key the user
 * accepted during a signed-plugin install. Drives "auto-trust subsequent
 * updates from the same author" semantics across HTTP/Git install paths.
 */
export interface TrustedPublisherRow {
  /** Base64-encoded Ed25519 public key (primary key). */
  publicKey: string
  /** SHA-256 hex digest of the public key, for the install-dialog UI. */
  fingerprint: string
  /** Display name from `manifest.author.name` at first-trust time. */
  authorName?: string
  /** Optional contact email captured from `manifest.author.email`. */
  authorEmail?: string
  /** Optional homepage / repository URL captured at first-trust time. */
  homepage?: string
  /** Epoch ms of first accept. */
  firstTrustedAt: number
  /** Epoch ms of the most-recent install/update by this author. */
  lastSeenAt: number
  /** Counter — number of distinct plugins installed by this author. */
  installCount: number
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
