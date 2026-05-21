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
import type { Twin, TwinSource, TwinChunk, TwinProfile, TwinDraft, TwinJob } from "@/types/twin"
import type { MobileOutboundJobRow } from "./mobile-outbound-types"
import type {
  PluginRow,
  PluginPermissionRow,
  PluginReviewRow,
  PluginAnalyticsRow,
  PluginScheduledJobRow,
} from "./plugin-types"
import type { WikiArticle, WikiSection, WikiManifest, McpAuditLogRow } from "@/types/wiki"
import type { SubscriptionUsageRow } from "@/lib/subscription/core/types"
import type {
  AdapterInstanceRow,
  PlatformIdentityRow,
  InboundLedgerRow,
  OutboundJobRow,
  ConversationOverrideRow,
  ConnectorAuditRow,
  ConnectorDraftRow,
  ConnectorAttachmentRow,
  ConnectorCallbackBindingRow,
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
import type { Goal, GoalEvent } from "@/types/goal"
import type { OcrResultRow } from "./ocr-results"
import type { PluginSkillUsageRow } from "./plugin-skill-usage"
import type { WorkflowProposalHistoryRow } from "@/lib/workflow/editor/proposal-history"
import type { SyncCursorRow } from "@/lib/sync/types"

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
  twins!: Table<Twin, string>
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
  connectorCallbackBindings!: Table<ConnectorCallbackBindingRow, string>
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
  // v30 — `/goal` command subsystem (ADR-0013). `chatGoals` is one row per
  // goal, session-scoped (one active per session enforced by writer); status
  // transitions are append-only and immutable past terminal. `chatGoalEvents`
  // is the lifecycle audit trail driving the Activity tab + History view.
  chatGoals!: Table<Goal, string>
  chatGoalEvents!: Table<GoalEvent, string>
  /**
   * v35 — Visual workflow editor viewport bookmarks. One row per saved view,
   * scoped to a workflow. The `[workflowId+createdAt]` compound index drives
   * the "Views" dropdown's newest-first listing. Pure additive; no upgrade
   * hook needed.
   */
  workflowViewportBookmarks!: Table<WorkflowViewportBookmarkRow, string>
  /**
   * v36 — OCR result cache (ADR-0024). Primary key is the canonical
   * `${sha256(file)}|${providerId}|${sortedLangs.join(",")}` id built by
   * `buildOcrCacheId()`. Indexed by `providerId` so the settings page can
   * purge per-provider, and by `createdAt` for TTL-based cleanup. Pure
   * additive; no upgrade hook needed.
   */
  ocrResults!: Table<OcrResultRow, string>
  /**
   * v37 — Plugin-skill usage telemetry. One row per plugin-contributed
   * skill id. Written by `lib/db/plugin-skill-usage.ts:recordPluginSkillUsage`
   * on each chat send that resolves the plugin skill; read by plugin
   * telemetry surfaces. Pure additive; no upgrade hook needed.
   */
  pluginSkillUsage!: Table<PluginSkillUsageRow, string>
  /**
   * v42 — Workflow proposal history. One row per terminal (applied /
   * discarded) proposal so the Changelog tab can render a timeline.
   * Capped at 50 rows per workflow by `pruneOldProposalHistory()` in
   * `lib/workflow/editor/proposal-history.ts`. Pure additive table; no
   * upgrade hook needed.
   */
  workflowProposalHistory!: Table<WorkflowProposalHistoryRow, string>

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

    // v30 — `/goal` command (ADR-0013). Pure additive; no upgrade hook.
    //   • `chatGoals`      — `&id` primary; `sessionId` for "active goal of
    //                         this session" lookups by the composer pill;
    //                         `[sessionId+status]` so the "find the one
    //                         active goal in this session" query is
    //                         index-driven (writer enforces the unique
    //                         constraint, not the index); `status` standalone
    //                         for the global History tab; `characterId` for
    //                         per-character filters; `createdAt` for
    //                         newest-first listing; `updatedAt` for
    //                         live-query refreshes.
    //   • `chatGoalEvents` — `&id` primary; `goalId` for cascade-delete;
    //                         `[goalId+ts]` for in-order Activity render;
    //                         `kind` for kind-filtered audit views;
    //                         `ts` for global newest-first when needed.
    this.version(30).stores({
      chatGoals: "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt",
      chatGoalEvents: "&id, goalId, [goalId+ts], kind, ts",
    })

    // v31 — VS Code extension reuse layer
    // (see ~/.claude/plans/vscode-snug-squid.md).
    //   • `openVsxCache` — 24h TTL metadata cache for Open VSX marketplace
    //     entries. `&extensionId` is the canonical `publisher.name` string,
    //     `fetchedAt` drives the staleness check.
    //   • `vscodeExtensionRuntime` — per-extension runtime telemetry. Cap is
    //     enforced lazily by the row writer (one row per installed extension;
    //     no listing query, just lookups), so no compound index needed.
    this.version(31).stores({
      openVsxCache: "&extensionId, fetchedAt",
      vscodeExtensionRuntime: "&extensionId, lastActivatedAt, lastError, sidecarPid",
    })

    // v32 — Character.enableComputerUse + Character.computerUseSettings (ADR-0020).
    //   No store-shape changes: every new field on `Character` is optional, so
    //   existing rows round-trip unchanged. We still bump the version to give
    //   the next contributor a clean anchor — and to surface in the migration
    //   audit trail that v32 corresponds to the Computer Use completion work.
    this.version(32).stores({})

    // v33 — ADR-0021 WebRTC WAN transport: `PairedDeviceRow.rendezvousId` and
    //   `PairedDeviceRow.rendezvousSecret` are minted by the desktop pair
    //   handler and propagated through `companion://device-paired`. Both are
    //   optional (non-indexed JSON columns), so no `.stores()` change is
    //   required — IndexedDB stores the extra keys transparently. The
    //   version bump records that pre-v33 rows have neither field and the
    //   transport must therefore treat them as WebRTC-disabled until the
    //   user re-pairs.
    this.version(33).stores({})

    // v34 — Twin registry table. The container row that binds Character →
    // Twin and powers archive/rename/delete from the Twin Selector UI. Pure
    // additive on the schema side; the upgrade hook walks every existing
    // twin* table plus the `characters.twinId` field to ensure a registry
    // row exists for legacy twinIds, so pre-v34 installs with twin data but
    // no registry row land in a coherent state.
    //   • `&id`         — primary key (`twn_*`).
    //   • `updatedAt`   — newest-first listing in the selector.
    //   • `archived`    — boolean filter for the "Show archived" toggle.
    //   • `createdAt`   — debug / data settings sort.
    this.version(34)
      .stores({
        twins: "&id, updatedAt, archived, createdAt",
      })
      .upgrade(async (tx) => {
        const twinsTable = tx.table("twins")
        const existing = new Set((await twinsTable.toArray()).map((t: { id: string }) => t.id))
        const seen = new Set<string>()
        const collectTwinIds = async (tableName: string) => {
          const rows = await tx.table(tableName).toArray()
          for (const row of rows) {
            const id = (row as { twinId?: string }).twinId
            if (id) seen.add(id)
          }
        }
        await collectTwinIds("twinSources")
        await collectTwinIds("twinChunks")
        await collectTwinIds("twinProfile")
        await collectTwinIds("twinDrafts")
        await collectTwinIds("twinJobs")
        const charactersByTwin = new Map<string, { name?: string }>()
        for (const character of await tx.table("characters").toArray()) {
          const id = (character as { twinId?: string }).twinId
          if (id) {
            seen.add(id)
            if (!charactersByTwin.has(id)) charactersByTwin.set(id, character)
          }
        }
        const now = Date.now()
        for (const id of seen) {
          if (!id || existing.has(id)) continue
          const character = charactersByTwin.get(id)
          await twinsTable.add({
            id,
            name: character?.name || id,
            createdAt: now,
            updatedAt: now,
          })
        }
      })

    // v35 — Visual workflow editor viewport bookmarks (Phase 3 of the
    // editor's Flowith-inspired feature track). Indexed columns:
    //   • `&id`                       — primary key (`vb_` + nanoid).
    //   • `workflowId`                — scope filter.
    //   • `[workflowId+createdAt]`    — newest-first dropdown listing.
    this.version(35).stores({
      workflowViewportBookmarks: "&id, workflowId, [workflowId+createdAt]",
    })

    // v36 — OCR result cache (ADR-0024). Indexed columns:
    //   • `&id`         — primary key `${sha256(file)}|${providerId}|${langs}`.
    //   • `providerId`  — per-provider purge in settings.
    //   • `createdAt`   — TTL purge.
    //   • `fileSha`     — "delete every cached result for this file".
    this.version(36).stores({
      ocrResults: "&id, providerId, createdAt, fileSha",
    })

    // v37 — Plugin-skill usage telemetry. Mirrors the per-row
    // `usageCount` / `lastUsedAt` columns on `skills`, but for plugin-
    // contributed runtime skills which have no Dexie row of their own.
    // One row per plugin skill id; the writer `recordPluginSkillUsage`
    // upserts on each chat send that resolves the plugin skill.
    //   • `&pluginSkillId` — primary key (the plugin's skill id string).
    //   • `lastUsedAt`     — newest-first listing in plugin telemetry UIs.
    //   • `pluginId`       — bulk-purge on plugin uninstall.
    this.version(37).stores({
      pluginSkillUsage: "&pluginSkillId, lastUsedAt, pluginId",
    })

    // v38 — A2UI ⇄ IM connector bridge support.
    //
    //   • `inboundLedger` gains a `namespace` field so the same dedup
    //     ledger can serve inbound messages AND connector callbacks (Slack
    //     block_actions / Lark card actions / Telegram callback_query /
    //     Discord component interactions). The compound index
    //     `[adapterId+namespace+platformMessageId]` replaces the v18
    //     `[adapterId+platformMessageId]` so lookups remain O(1). The
    //     upgrade hook backfills `namespace = "inbound"` on every legacy
    //     row so the new query path still finds them.
    //
    //   • `connectorCallbackBindings` is a new table — one row per
    //     (adapter, A2UI surface, component, platform action_id). Written
    //     by the platform-specific A2UI mapper at outbound send; read by
    //     the adapter parser when a callback arrives so the bus can route
    //     it back to the right surface/component without re-parsing the
    //     outbound payload. Indexed by `[adapterId+actionId]` for O(1)
    //     callback-arrival lookup, by `surfaceId` for surface-scoped
    //     cleanup (e.g., when an A2UI surface is destroyed), and by
    //     `createdAt` for LRU prune.
    //
    //   • `adapterInstances` gains an in-row `lastKnownCapabilities`
    //     column written at adapter start — no index change because the
    //     resolver always loads the row by primary key.
    this.version(38)
      .stores({
        inboundLedger:
          "&id, [adapterId+namespace+platformMessageId], adapterId, receivedAt, namespace",
        connectorCallbackBindings:
          "&id, [adapterId+actionId], adapterId, surfaceId, conversationKey, createdAt, expiresAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("inboundLedger")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.namespace !== "string") {
              row.namespace = "inbound"
            }
          })
      })

    // v39 — VS Code-extension LSP binary trust seed (Phase A of the LSP
    // reuse work). Pre-populates `trustedPublishers` with the public
    // signing keys of mainstream extension publishers (Microsoft, rust-
    // lang, golang, palantir, python-lsp, openvsx, dbaeumer, ms-python,
    // eamodio) so users don't get prompted on every spawn of well-known
    // LSP binaries. Idempotent: existing user-trusted rows are never
    // overwritten; placeholder rows from this seed are replaced when a
    // future release ships verified fingerprints. See
    // `lib/db/seed/trusted-publishers.ts`.
    this.version(39).upgrade(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { seedTrustedPublishers } = require("@/lib/db/seed/trusted-publishers") as {
        seedTrustedPublishers: (
          tx: unknown
        ) => Promise<{ inserted: number; updated: number; skipped: number }>
      }
      await seedTrustedPublishers(tx as unknown as Parameters<typeof seedTrustedPublishers>[0])
    })

    // v40 — Computer Use chat-side dispatch completeness (ADR-0020 addendum
    //   2026-05-18). Two additive fields:
    //     • `Character.computerUseSettings.chatConsentMode` — controls the
    //       chat-side canUseTool modal cadence ("always-ask" | "session-grant"
    //       | "auto"). Defaults to "always-ask" when unset.
    //     • `ClickOpts.count` — number of consecutive clicks (1/2/3). Used
    //       by Anthropic `triple_click` actions. Backwards-compatible — the
    //       existing `double` field still wins when `count` is unset.
    //   No store-shape changes; both fields are optional on existing rows.
    this.version(40).stores({})

    // v41 — IM connector complete gap closure (ADR-0009 v41, im-a2ui-warm-
    //   eclipse plan). One migration bundles five additive changes; no
    //   table is dropped, no column is renamed, no row is rewritten beyond
    //   the connectorCallbackBindings `kind` backfill and the
    //   outboundQueue `source` backfill.
    //
    //   • `connectorCallbackBindings` gains a `kind` discriminator
    //     ("callback_query" | "force_reply" | "modal_open" | "block_action")
    //     so the bus can route inbound platform callbacks to the right
    //     correlation path. Adds `kind` as a non-compound index so the
    //     LRU prune + maintenance UIs can do per-kind filters. Rows
    //     persisted before v41 backfill to `"callback_query"` (the only
    //     case the v38 schema supported).
    //
    //   • `outboundQueue.source` (enum: "ai-run" | "manual" | "workflow" |
    //     "draft-approved") + optional `sourceWorkflow` triple — captures
    //     job provenance so the inbox UI can render a workflow badge and
    //     so audit log queries can drill down on origin. Rows persisted
    //     before v41 backfill to `"ai-run"` because that's the only path
    //     that existed when they were created. No index change (filter
    //     column).
    //
    //   • `conversationOverrides` gains `providerOverride?: string` +
    //     `modelOverride?: string`. Both are filter-only columns on this
    //     small per-conversation table, so no index change is needed.
    //
    //   • `adapterInstances` gains `implMetadata?: {impl, version,
    //     features}` — populated by adapter startup probes (OneBot
    //     `get_version_info`, Slack `auth.test`, etc.). No index change.
    //
    //   • `automationAuditLog.conversationKey?: string` — so the inbox's
    //     computer-use HITL strip can filter to the conversation that
    //     drove the action. Index `conversationKey` so the filter is
    //     selective.
    this.version(41)
      .stores({
        connectorCallbackBindings:
          "&id, [adapterId+actionId], adapterId, kind, surfaceId, conversationKey, createdAt, expiresAt",
        automationAuditLog: "&id, ts, surface, decision, command, conversationKey",
      })
      .upgrade(async (tx) => {
        await tx
          .table("connectorCallbackBindings")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.kind !== "string") {
              row.kind = "callback_query"
            }
          })
        await tx
          .table("outboundQueue")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.source !== "string") {
              row.source = "ai-run"
            }
          })
      })

    // v42 — Workflow proposal history (Changelog tab). One row per
    //   terminal applied / discarded proposal. `id` is `${proposalId}:
    //   ${status}`; per-workflow listing keys on `[workflowId+createdAt]`
    //   for newest-first reads. Capped at 50 per workflow by
    //   `lib/workflow/editor/proposal-history.ts`.
    this.version(42).stores({
      workflowProposalHistory: "&id, workflowId, createdAt, [workflowId+createdAt]",
    })

    // v43 — Built-in skills tier + lark-cli bridge (ADR-0026).
    //
    //   All changes are additive optional columns; no index is added,
    //   no table is created, no row is rewritten:
    //
    //   • `connectorCallbackBindings.payload?: Record<string, unknown>` —
    //     free-form structured payload the bus passes to kind-specific
    //     dispatchers. Used by the new `kind: "skill_invoke"` to carry
    //     `{skillId, args}` from confirm-card outbound to inbound
    //     callback so the skill re-fires with HITL bypass.
    //   • `connectorCallbackBindings.kind` enum widened to include
    //     `"skill_invoke"` (no schema declaration needed — `kind` is
    //     already an index column at v41 and Dexie filter-only at that
    //     level; the wider union is purely a type-level change).
    //   • `conversationOverrides.allowedBuiltInSkillIds?:
    //     string[] | "all"` and `requireHitlForWrites?: boolean` — per-
    //     channel gating for the built-in skill tier. Filter-only
    //     columns; no index.
    //   • `adapterInstances.lastKnownSkillCapabilities?:
    //     readonly PlatformSkillCapability[]` — sibling of the existing
    //     `lastKnownCapabilities` A2UI matrix cache. Written at adapter
    //     start by adapters that expose built-in skill families
    //     (Lark in v1). Filter-only; no index.
    //
    //   Pre-v43 rows that lack these fields are interpreted by the
    //   resolver as "fall back to per-skill defaults" / "no skill
    //   capabilities cached" — no backfill needed.
    this.version(43).stores({})

    // v44 (Wave 4 / ADR-0026) — persistent cursors for the companion sync
    // orchestrator. Previously `stateMap` lived only in memory, so a cold
    // start re-pulled every table from `since: 0`. With this table the
    // mobile shell resumes from the last successful cursor across app
    // restarts. Primary key `&table` enforces one row per syncable table.
    // Pure additive — no upgrade hook needed; pre-v44 installs start with
    // an empty cursor table and the orchestrator falls back to `since: 0`.
    this.version(44).stores({ syncCursors: "&table, lastSyncAt, since" })

    // v45 — IM connector Lark-first completeness pass (im-refactored-crayon
    //   plan). Pure additive optional columns on `adapterInstances`; no
    //   index changes, no row rewrites, no upgrade hook.
    //
    //   • `atResponseStrategy?: "always" | "mention_only" | "direct_only"` —
    //     gates inbound Lark messages in `dispatchEnvelope` via the new
    //     `lib/connectors/adapters/lark/at-gate.ts:shouldRespondToMessage`.
    //     Rows without the field behave as `"mention_only"` (the safer
    //     default for new Lark adapters); DMs (`chatType === "p2p"`) always
    //     bypass the strategy regardless.
    //   • `chatAllowlist?: string[]` / `chatBlocklist?: string[]` — same
    //     gate. Allowlist non-empty means "only these chat_ids may respond";
    //     blocklist hit means "never respond here".
    //   • `lastWhoamiAt?: number` + `lastWhoamiResult?` — cached bot
    //     identity probe written by
    //     `lib/connectors/adapters/lark/whoami.ts:probeBotIdentity`. The
    //     Settings Lark detail panel renders it so the operator can
    //     confirm "connected to the right bot" without a second click.
    //   • `userTokenStoredAt?: number` — flag indicating when an OAuth
    //     user-access-token was persisted to the keyring under
    //     `<adapterId>:user_token`. Used by the OAuth card to show
    //     "Connected as <user>" vs "Connect with Lark".
    //
    //   None of these fields are indexed (all are filter-only blobs read
    //   from the adapter row by primary key), so the bump is `stores({})`.
    this.version(45).stores({})

    // v46 — companion pause/resume affordance on `pairedDevices`. Adds an
    //   optional `pausedAt?: number` column read by the Settings UI to
    //   distinguish "temporarily blocked, can be resumed" from "revoked,
    //   biometric required to undo". The Rust deny-list is what actually
    //   enforces the block (paused devices are added to the same deny-list
    //   as revoked ones, then removed on resume) — `pausedAt` is purely
    //   the persistence layer's record of "why" it's in the deny-list, so
    //   no new index is needed. Pure additive; no upgrade hook.
    this.version(46).stores({})

    // v47 — Appearance optimization (ADR-0029). Adds optional fields to the
    //   `settings` singleton row: `density`, `radius`, `motion`,
    //   `typographyExt`, `a11y`, `autoMode`, `monacoLink`, `activeThemePackId`,
    //   `customCssScope`. All fields are optional in `AppSettings`; the
    //   appliers consume the defaults from `@/types/appearance` when missing.
    //   Pure additive — no upgrade hook needed; lazy backfill happens in the
    //   appliers / settings selectors rather than during DB upgrade so the
    //   Dexie callback stays non-blocking.
    this.version(47).stores({})
  }

  sessionState!: Table<SessionStateRow, string>
  tts_provider_keys!: Table<TtsProviderKeyRow, string>
  openVsxCache!: Table<OpenVsxCacheRow, string>
  vscodeExtensionRuntime!: Table<VscodeExtensionRuntimeRow, string>
  // v44 — companion sync cursors (Wave 4 / ADR-0026). See `lib/sync/types.ts`.
  syncCursors!: Table<SyncCursorRow, string>
}

/** Web-mode fallback row for TTS provider API keys. */
export interface TtsProviderKeyRow {
  /** "tts.providerKey.<provider>" */
  id: string
  value: string
}

/**
 * Open VSX marketplace metadata cache entry (v31, 24h TTL).
 * Keyed by canonical `publisher.name` identifier.
 */
export interface OpenVsxCacheRow {
  /** Canonical identifier — e.g. `"esbenp.prettier-vscode"`. */
  extensionId: string
  /** Epoch milliseconds when this entry was written. Stale after 24h. */
  fetchedAt: number
  /** Display name from the Open VSX response. */
  displayName: string
  /** Latest available version on Open VSX. */
  latestVersion: string
  /** Marketplace icon URL (CDN-backed). */
  iconUrl?: string
  /** Tags / categories from Open VSX, for filtered browse. */
  categories: string[]
  /** Download count, for sort-by-popular. */
  downloadCount: number
  /** Star rating, for sort-by-rating. */
  averageRating?: number
  /** Whether Open VSX has verified the publisher. */
  verified: boolean
  /**
   * Raw response payload (JSON-serialised) so the UI can render details
   * without a second round trip. Kept compact; full README / changelog
   * are fetched on-demand.
   */
  payload: unknown
}

/**
 * Per-extension runtime telemetry written by the VS Code sidecar.
 * Used by the Plugins → Extensions → VS Code surface to surface
 * "Last activated", "Last error", "Sidecar process id".
 */
export interface VscodeExtensionRuntimeRow {
  /** Canonical `publisher.name`. */
  extensionId: string
  /** Epoch ms of the most recent successful activate(). */
  lastActivatedAt: number | null
  /** Last sidecar-reported error message, or null if no error since last reset. */
  lastError: string | null
  /** PID of the Node sidecar hosting this extension when active; 0 when not running. */
  sidecarPid: number
  /** Sum of permission grants prompted during this extension's lifetime. */
  runtimePermissionGrants: number
  /** Sum of permission denials prompted during this extension's lifetime. */
  runtimePermissionDenials: number
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
 *
 * `conversationKey` was added at schema v41 so the inbox can surface the
 * computer-use HITL request/decision timeline scoped to the conversation
 * that drove the action (see ADR-0009 v41 / Category E3 in the IM
 * connector gap-closure plan). Existing rows have the field undefined.
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
  /**
   * Connector conversation key the computer-use action was initiated
   * from, when known. Populated when the surface is `"computerUse"` and
   * the chat session has a `platformBinding`. Used by
   * `components/inbox/computer-use-events-strip.tsx` to filter by
   * conversation. Optional because workflow / MCP / plugin invocations
   * may not have a conversation context.
   */
  conversationKey?: string
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

/**
 * Per-workflow viewport bookmark. Persists the user-saved `{x, y, zoom}` so
 * the "Views" dropdown can restore it later with a smooth tween.
 */
export interface WorkflowViewportBookmarkRow {
  /** `vb_` + nanoid. */
  id: string
  workflowId: string
  /** User-supplied label (defaults to "View at NN%" in the UI). */
  name: string
  viewport: { x: number; y: number; zoom: number }
  createdAt: number
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
