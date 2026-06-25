// IndexedDB schema (via Dexie) for cognia-next — the single `CogniaDB`
// instance backing chat, plugins, connectors, workflows, twin, and more.
//
// HARD RULE: never reorder, edit, or delete a historical `version(N).stores()`
// block or its `upgrade()` hook — doing so corrupts live user databases. Only
// ever append a new, higher version. See `lib/db/CONVENTIONS.md` for the data
// layer's ID / timestamp / error-handling / type-location conventions.
//
// Row types co-locate with their CRUD module (or a `*-types.ts` file) and are
// re-exported below so `@/lib/db/schema` stays the stable import surface.

import Dexie, { type Table } from "dexie"
import type {
  AppSettings,
  Character,
  ChatSession,
  McpServer,
  SessionFolder,
  Skill,
  SkillResource,
  StoredMessage,
  SystemPromptPreset,
  Team,
} from "@/lib/claude/types"
import type { Project } from "@/types"
import type { TrustedWorkspace } from "./trusted-workspaces"
import type { BackupHistoryRow } from "./backup-history"
import type { NotificationRecord } from "@/types/notifications"
import type { SandboxConnectionRow } from "./sandbox-connections"
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
  PluginMarketplaceSourceRow,
  PluginDexieMeta,
} from "./plugin-types"
import type { WikiArticle, WikiSection, WikiManifest, McpAuditLogRow } from "@/types/wiki"
import type {
  ProviderLimitsRow,
  SubscriptionBalanceRow,
  SubscriptionUsageRow,
} from "@/types/subscription"
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
  ConnectorHeartbeatRow,
  WorkflowFanoutSubscriptionRow,
} from "./connector-types"
import type {
  ConversationLabelRow,
  ConversationAssignmentEventRow,
  CannedResponseRow,
} from "./crm-types"
import type {
  WorkflowRow,
  WorkflowRunRow,
  WorkflowRunEventRow,
  WorkflowTriggerRow,
} from "@/types/workflow/visual"
import type { WorkflowFolder } from "@/types/workflow/folder"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { SessionUsageRow } from "./session-usage"
import type { ChatDraftRow } from "./chat-drafts"
import type { ChatInputHistoryRow } from "./chat-input-history"
import type { Goal, GoalEvent, GoalTemplate } from "@/types/goal"
import type { Loop, LoopEvent } from "@/types/loop"
import type { AgentPlan, PlanEvent } from "@/types/agent/plan"
import type { RemoteControlAuditEntry } from "@/types/remote-control"
import type { OcrResultRow } from "./ocr-results"
import type { PluginSkillUsageRow } from "./plugin-skill-usage"
import type { WorkflowProposalHistoryRow } from "@/lib/workflow/editor/proposal-history"
import type { InboxTelemetryEventRow } from "./inbox-telemetry-types"
import type { SyncCursorRow, SyncTombstoneRow, SyncableTable } from "@/lib/sync/types"
import type { SharedLinkRow } from "./shared-links"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { PetModelRow, PetModelFileRow } from "./pet-models"
import type { TerminalHistoryRow } from "./terminal-history"
import type { ProviderCostDailyRow } from "./provider-cost-daily"
import type { UnattendedExecAuditRow } from "./terminal-audit"
// Row types relocated out of this file but still wired into the table
// declarations below and re-exported at the bottom for `@/lib/db/schema`
// import-site stability. See `lib/db/CONVENTIONS.md`.
import type { ModelsDevCatalogRow } from "./models-dev-catalog"
import type { SessionStateRow } from "./session-state"
import type { TrustedPublisherRow } from "./trusted-publishers"
import type { TtsProviderKeyRow } from "@/types/media/tts"
import type {
  OpenVsxCacheRow,
  VscodeExtensionRuntimeRow,
} from "@/types/plugin/vscode-extension-cache"
import type { AutomationAuditLogRow } from "@/lib/automation/audit"
import type { WorkflowViewportBookmarkRow } from "@/lib/workflow/editor/viewport-bookmarks-db"
import type { EvalCase, EvalDataset } from "@/types/eval/eval"
import type { EvalRunRow } from "./eval-runs"
import type { TraceAnnotationRow } from "./trace-annotations"
import type { EvalDatasetVersion } from "@/types/eval/version"
import type { EvalRunCaseRow } from "./eval-run-cases"
import type { CalibrationItemRow } from "./calibration-items"
import type { CalibrationRunRow } from "./calibration-runs"
import type { BackgroundTaskJournalRow } from "./background-tasks"
import type { WasmGrantLedgerRow } from "./wasm-grant-ledger"
import type { RunRecordRow } from "./run-records"
import type { Memory } from "@/types/memory/memory"
import type {
  PetProfile,
  PetActivityRow,
  PetCharacterBinding,
  PetAchievementRecord,
  PetConversationRow,
} from "@/types/pet"
import { accountDatabaseName } from "@/lib/accounts/account-db"
import { rootsFromLegacy } from "@/lib/workspace/roots"
import { backfillProjectScopeV86 } from "./project-scope-backfill"

/**
 * Idempotently backfill `roots` on a project row from the legacy
 * rootDir/additionalDirs mirrors. Used by the v66 upgrade and unit-tested
 * directly (the upgrade only fires on a live version transition).
 */
export function backfillRootsForRow(row: Project): Project {
  if (row.roots) return row
  row.roots = rootsFromLegacy(row.rootDir, row.additionalDirs)
  return row
}

export const LEGACY_COGNIA_DB_NAME = "cognia-claude"

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
  notifications!: Table<NotificationRecord, string>
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
  // v83 — Connector CRM (Chatwoot-style). Row types in `./crm-types.ts`.
  conversationLabels!: Table<ConversationLabelRow, string>
  conversationAssignmentEvents!: Table<ConversationAssignmentEventRow, string>
  cannedResponses!: Table<CannedResponseRow, string>
  connectorAttachments!: Table<ConnectorAttachmentRow, string>
  connectorCallbackBindings!: Table<ConnectorCallbackBindingRow, string>
  // v51 — Heartbeats split out of `connectorAudit`. Capped per-adapter by
  // the heartbeat sweep (`lib/connectors/health/heartbeat.ts`), not by the
  // audit writer, so heartbeat churn no longer evicts real audit events.
  connectorHeartbeats!: Table<ConnectorHeartbeatRow, string>
  // v20 — Claude subscription usage table. One row per `anthropic-ratelimit-
  // unified-*` header snapshot; capped at 1 000 rows newest-first by
  // `lib/anthropic-subscription/usage-collector.ts`.
  subscriptionUsage!: Table<SubscriptionUsageRow, number>
  // v70 — Subscription balance snapshots (ADR-0025 Phase 3). Capped at 500
  // newest-first by `lib/subscription/balance/store.ts`.
  subscriptionBalance!: Table<SubscriptionBalanceRow, number>
  // v84 — Unified provider limits/usage snapshots (ADR-0025 follow-up). One
  // row per `ProviderLimits` reading across every subscription provider
  // (Anthropic windows, Codex windows, credit balances). Capped at 500
  // newest-first by `lib/subscription/limits/store.ts`.
  providerLimits!: Table<ProviderLimitsRow, number>
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
  // v52 — Workflow library folders (ADR-0011 library upgrade). See
  // `types/workflow/folder.ts`.
  workflowFolders!: Table<WorkflowFolder, string>
  // v55 — Workflow run fan-out subscriptions (im-a2ui-abstract-anchor
  // Phase 7). Operator-configured "every run of workflow X mirrors
  // progress to channel Y". See `connector-types.ts` for the row shape.
  workflowFanoutSubscriptions!: Table<WorkflowFanoutSubscriptionRow, string>
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
  // v80 — Per-session sent-message history for ↑/↓ recall in the composer.
  // Auto-increment id; compound `[sessionId+createdAt]` powers newest-first
  // listing; capped per session by `lib/db/chat-input-history.ts`.
  chatInputHistory!: Table<ChatInputHistoryRow, number>
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
  // v79 — /loop command (recurring prompts). Mirrors the goal pair: `loops`
  // is one row per loop, session-scoped; `loopEvents` is the audit trail.
  loops!: Table<Loop, string>
  loopEvents!: Table<LoopEvent, string>
  // v53 — reusable goal templates (ADR-0019 Phase 2). Built-ins seeded on
  // access; booleans (builtin/isFavorite) are filtered in-memory by the CRUD
  // layer since IndexedDB doesn't index booleans reliably.
  goalTemplates!: Table<GoalTemplate, string>
  // v71 — Unified Plan Execution Hub (ADR-0045). `agentPlans` is one row per
  // plan, session-scoped (one "open" plan per session enforced by the writer
  // in `lib/db/plans.ts`); `agentPlanEvents` is the append-only lifecycle log
  // driving the tracker panel + audit trail (capped per-plan).
  agentPlans!: Table<AgentPlan, string>
  agentPlanEvents!: Table<PlanEvent, string>
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
  /**
   * v54 — Cloudflare-hosted public share links (zero-knowledge). One row per
   * link the owner created, so the "My Shares" panel can list / re-copy /
   * revoke. The URL embeds the decryption key, which lives only on this device.
   * Per-row type + CRUD live in `./shared-links.ts`. Pure additive table.
   */
  sharedLinks!: Table<SharedLinkRow, string>
  /**
   * v55 — Agent-trace span rows (ADR pending). One row per finished span
   * emitted by `lib/agent-trace/emitter.ts:endSpan` and persisted by
   * `lib/logging/transports/agent-trace-transport.ts`. Indexed by
   * `[sessionId+startTime]` for newest-first chat-side queries, by `traceId`
   * for trace-timeline rendering, by `[traceId+startTime]` so trace views
   * can sort without a second pass, and by `parentSpanId` for child-span
   * lookup. Per-row type lives in `@/types/agent-trace/span.ts`; CRUD +
   * aggregation helpers in `./agent-traces.ts`.
   */
  agentTraces!: Table<AgentTraceSpan, string>
  /**
   * v64 — Agent evaluation subsystem. `evalDatasets` holds versioned,
   * capability-scoped collections; `evalCases` holds the per-dataset test
   * items; `evalRuns` holds one {@link EvalReport} per executed run (the
   * dashboard's trend source); `traceAnnotations` records error-analysis
   * labels on real `agentTraces` (open/axial coding + "save as eval case").
   * Per-row types + CRUD live in `./eval-datasets.ts`, `./eval-runs.ts`,
   * `./trace-annotations.ts`. See the design doc
   * `docs/superpowers/specs/2026-06-01-cognia-agent-eval-design.md`.
   */
  evalDatasets!: Table<EvalDataset, string>
  evalCases!: Table<EvalCase, string>
  evalRuns!: Table<EvalRunRow, string>
  traceAnnotations!: Table<TraceAnnotationRow, string>
  // v69 — Eval dataset version snapshots + per-case run results. See
  // `./eval-dataset-versions.ts` and `./eval-run-cases.ts`.
  evalDatasetVersions!: Table<EvalDatasetVersion, string>
  evalRunCaseResults!: Table<EvalRunCaseRow, string>
  // v82 — Judge calibration loop (eval spec §10). `calibrationItems` holds
  // human-gold-labeled (input, answer) pairs grouped into sets; `calibrationRuns`
  // holds one full agreement report (confusion matrix + Cohen's κ + per-item
  // verdicts) per executed calibration. CRUD in `./calibration-items.ts` and
  // `./calibration-runs.ts`.
  calibrationItems!: Table<CalibrationItemRow, string>
  calibrationRuns!: Table<CalibrationRunRow, string>
  // v87 — Journaled background subagent tasks. A1 keeps execution in the
  // renderer/CLI heap, but records lifecycle transitions here so Job Center and
  // post-reload collect can distinguish done/error/interrupted history.
  backgroundTasks!: Table<BackgroundTaskJournalRow, string>
  // v88 — Durable WASM preopen grant ledger. See `lib/db/wasm-grant-ledger.ts`.
  wasmGrantLedger!: Table<WasmGrantLedgerRow, string>
  // v89 — Per-turn Run Records (Run Panel). See `lib/db/run-records.ts`.
  runRecords!: Table<RunRecordRow, [string, number]>
  // v90 — Conversation folders. See `lib/db/session-folders.ts`.
  sessionFolders!: Table<SessionFolder, string>

  constructor(name = LEGACY_COGNIA_DB_NAME) {
    super(name)

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

    // v48 — Character pack overlay capability (ADR-0030). Adds four optional
    //   non-indexed fields to `characters` rows: `sourcePluginId`,
    //   `sourcePackId`, `clonedFromPackCharacterId`, `packVersionAtClone`. The
    //   fields are populated only when a user duplicates a plugin-overlay
    //   character into a Dexie row, so existing rows remain valid with all
    //   four undefined → treated as "user-created" by the badge logic. Pure
    //   additive — no upgrade hook, no index change.
    this.version(48).stores({})

    // v49 — Inbox optimization pass (plan: inbox-fluttering-tome).
    //
    //   1. `messages` gains a denormalized, indexed `platformMessageId`
    //      column populated from `metadata.platformMessage.messageId`. The
    //      column lets `ConnectorBus.applyMessageEdit` / `applyMessageDelete`
    //      replace a full-table `.toArray().find()` scan with an indexed
    //      `where("platformMessageId").equals(id).first()`. A platform
    //      safety filter at call-site prevents cross-platform collisions
    //      (Telegram messageId=12345 vs Discord messageId=12345).
    //
    //   2. New `inboxTelemetryEvents` ring-buffer table (cap 3000) backs
    //      the `lib/telemetry/inbox-events.ts` breadcrumb layer. Decoupled
    //      from `connectorAudit` so high-volume telemetry rotation does
    //      not displace the operator-visible 5000-row audit window.
    //
    //   Upgrade hook backfills `platformMessageId` once per row from the
    //   existing metadata. Streams via `toCollection().modify` so large
    //   mailboxes don't load all rows at once.
    this.version(49)
      .stores({
        messages: "id, sessionId, [sessionId+createdAt], senderId, platformMessageId",
        inboxTelemetryEvents: "&id, kind, at, adapterId, conversationKey",
      })
      .upgrade(async (tx) => {
        await tx
          .table("messages")
          .toCollection()
          .modify((row) => {
            const pmid = (row as { metadata?: { platformMessage?: { messageId?: unknown } } })
              ?.metadata?.platformMessage?.messageId
            if (typeof pmid === "string" && pmid.length > 0) {
              ;(row as { platformMessageId?: string }).platformMessageId = pmid
            }
          })
      })

    // v50 — Built-in characters → first-party character pack (ADR-0030
    //   Amendment, 2026-05-23). The six `char_builtin_*` rows pre-v50 were
    //   app-seeded with no `sourcePluginId`. The `cognia-builtin-characters`
    //   first-party plugin now ships those personas as overlay-registry
    //   entries; this upgrade tags the legacy Dexie rows so the new
    //   `clone-hides-overlay` dedupe rule in `listCharacters` treats them
    //   as user clones of the overlay characters. User customisations are
    //   preserved verbatim — only attribution fields are added.
    //
    //   `pristineSnapshot` is NOT backfilled here: the plugin manager
    //   hasn't booted yet at upgrade time, so the overlay registry is
    //   empty and we'd have nothing to compare against. The post-boot
    //   `seedBuiltInCharacters` runs a second-pass backfill once the
    //   plugin is active. Rows that fall through that window degrade
    //   gracefully — `applyPackUpdate` uses the "no baseline" path and
    //   surfaces a warning in the confirm dialog.
    //
    //   No store-shape change (every new field is optional non-indexed)
    //   so the upgrade hook only mutates rows — Dexie still requires an
    //   empty `.stores({})` to register the version number.
    this.version(50)
      .stores({})
      .upgrade(async (tx) => {
        const legacyMap: Record<string, string> = {
          char_builtin_coding: "coding",
          char_builtin_writer: "writer",
          char_builtin_research: "research",
          char_builtin_brainstorm: "brainstorm",
          char_builtin_translator: "translator",
          char_builtin_goal_tracker: "goal-tracker",
        }
        await tx
          .table("characters")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const localId = legacyMap[row.id as string]
            if (!localId) return
            if (row.sourcePluginId) return
            row.sourcePluginId = "cognia-builtin-characters"
            row.sourcePackId = "builtin"
            row.clonedFromPackCharacterId = `cognia-pack:cognia-builtin-characters:builtin:${localId}`
            row.packVersionAtClone = "1.0.0"
          })
      })

    // v51 — Connector recurring-work performance hardening. Pure additions
    // (two compound indexes + one table); no upgrade hook because existing
    // rows already carry the indexed fields, mirroring the v19/v21 pattern.
    //   • outboundQueue [status+nextAttemptAt] — lets the runner pick the
    //     next due job (and peek the next retry deadline) via an index range
    //     instead of a full-table `.filter()` scan.
    //   • connectorAudit [adapterId+kind+at] — lets the passive heartbeat
    //     read "last inbound.received for this adapter" as a pure index
    //     lookup instead of an `at`-range scan + JS `kind` filter.
    //   • connectorHeartbeats — dedicated heartbeat table (see field doc).
    this.version(51).stores({
      outboundQueue:
        "&id, conversationKey, [conversationKey+createdAt], status, nextAttemptAt, idempotencyKey, [adapterId+status], createdAt, [status+nextAttemptAt]",
      connectorAudit: "&id, adapterId, kind, at, [adapterId+at], [adapterId+kind+at]",
      connectorHeartbeats: "&id, adapterId, [adapterId+at], at",
    })

    // v52 — Workflow library folders + the `folderId` index on workflows
    // (ADR-0011 library upgrade). `workflowFolders` is a new additive table.
    // The `workflows` keyPath re-declares its full index list with the added
    // `folderId` so the library can range-query a folder's contents.
    //   • workflowFolders — &id primary; `parentFolderId` and the compound
    //                       [parentFolderId+name] drive the "children of folder
    //                       X, sorted by name" query that renders a folder's
    //                       sub-folders without a scan; `updatedAt`/`createdAt`
    //                       for debug/data views.
    //   • workflows.folderId — equality lookup for "workflows in folder X".
    //
    // The upgrade hook backfills every pre-existing row to the root sentinel
    // ("root"). This is REQUIRED: IndexedDB does not index `undefined`, so
    // without the backfill the library's `where("folderId").equals("root")`
    // read would never see legacy workflows.
    this.version(52)
      .stores({
        workflows:
          "&id, name, updatedAt, createdAt, isBuiltIn, isTemplate, *tags, schemaVersion, folderId",
        workflowFolders: "&id, name, parentFolderId, [parentFolderId+name], updatedAt, createdAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("workflows")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.folderId === undefined) row.folderId = "root"
          })
      })

    // v53 — Goal template library (ADR-0019 Phase 2). Additive table only;
    // no data migration (all new GoalConfig/GoalDefaults fields are optional
    // and round-trip on existing chatGoals rows). Built-in templates are
    // seeded on access (see `lib/goal/seed-templates.ts`). `sortOrder` drives
    // the picker order; `updatedAt`/`createdAt` for data views. Booleans are
    // filtered in-memory (the v12 promptPresets precedent).
    this.version(53).stores({
      goalTemplates: "&id, builtin, isFavorite, sortOrder, updatedAt, createdAt",
    })

    // v54 — public share links. Additive only; no upgrade hook. `code` is
    // unique; `createdAt` drives the newest-first list; `expiresAt` powers the
    // expired-row prune. `revoked` (boolean) is filtered in-memory, not indexed.
    this.version(54).stores({
      sharedLinks: "&id, &code, kind, createdAt, expiresAt",
    })

    // v55 — Agent-trace span rows. Additive only; no upgrade hook. Indexes:
    // `sessionId` and `[sessionId+startTime]` drive the per-session timeline
    // query; `traceId` and `[traceId+startTime]` drive the trace-grouped
    // detail view; `parentSpanId` lets the renderer pull child spans
    // without scanning; `surface` is filterable so the Settings →
    // Observability → Agent Trace tab can scope to one origin.
    this.version(55).stores({
      agentTraces:
        "&id, sessionId, [sessionId+startTime], traceId, [traceId+startTime], parentSpanId, surface",
    })

    // v56 — Workflow run fan-out subscriptions (im-a2ui-abstract-anchor
    // Phase 7). One row per "mirror progress for workflow X into channel
    // (adapter, conversation)". Additive only — no upgrade hook because
    // no pre-existing rows could carry this shape. Indexes:
    //   • `&id`               — uuid primary
    //   • `workflowId`        — runtime hot path: the progress-runner
    //                            queries by workflowId at watcher
    //                            creation to seed the fan-out channels.
    //   • `[workflowId+enabled]` — same query filtered to live rows so
    //                            the runner skips disabled subscriptions
    //                            without an in-memory pass.
    //   • `enabled`           — global "all live mirrors" view in
    //                            settings.
    //   • `adapterId` + `conversationKey` — the operator-side "what does
    //                            this channel mirror?" lookup.
    //   • `createdAt`         — newest-first sort in the settings list.
    this.version(56).stores({
      workflowFanoutSubscriptions:
        "&id, workflowId, [workflowId+enabled], enabled, adapterId, conversationKey, createdAt",
    })

    // v57 — Computer-Use sandbox connection registry (ADR-0020 remote-target
    // addendum). One row per cua desktop sandbox. Additive only — no upgrade
    // hook (no pre-existing rows carry this shape). Indexes:
    //   • `&id`        — uuid primary; the value target selectors reference.
    //   • `name`       — settings-list lookups.
    //   • `createdAt`  — newest-first sort in the Sandbox Connections tab.
    //   • `updatedAt`  — data views.
    this.version(57).stores({
      sandboxConnections: "&id, name, createdAt, updatedAt",
    })

    // v58 — add the `[twinId+fingerprint]` compound index to `twinSources` so
    // import-time dedup (`findTwinSourceByFingerprint`) is a direct compound
    // lookup instead of a full `fingerprint` index scan + JS `twinId` filter.
    // Additive index only — Dexie builds it on upgrade; no data migration.
    this.version(58).stores({
      twinSources:
        "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status], [twinId+fingerprint]",
    })

    // v59 — GitHub "marketplace repo" sources (Claude-Code-style plugin
    // dispatch). One row per added catalog repo. Additive only; no upgrade
    // hook. Indexes: `&id` (owner/repo[@ref] primary), `addedAt` (newest-first
    // list in the manage-sources dialog).
    this.version(59).stores({
      pluginMarketplaceSources: "&id, repoRef, addedAt",
    })

    // v60 — models.dev provider/model catalog cache. Single "singleton" row
    // holding the normalized catalog (keyed by our provider ids) + fetch
    // timestamp. Bundled snapshot seeds it on first run; runtime sync refreshes
    // it. See `lib/db/models-dev-catalog.ts` + `lib/ai/providers/models-dev-sync.ts`.
    this.version(60).stores({
      modelsDevCatalog: "&id, fetchedAt",
    })

    // v61 — Companion sync completeness pass (chat / workflow / settings).
    //   1. `syncTombstones` — new table recording desktop deletions so the
    //      `sync_pull` delta can carry `deleted_ids` (V1 always sent `[]`,
    //      leaving deleted rows orphaned on paired phones). Compound PK
    //      `[table+id]`; `table` + `deletedAt` indexed for per-table reads
    //      and the boot-time retention prune (`lib/sync/tombstones.ts`).
    //   2. `messages` gains a `[createdAt+id]` compound index so the desktop
    //      sync source can page chat history by creation order instead of
    //      scanning the whole table and capping at the newest 200 (see
    //      `desktop-sync-source.ts:readMessagesDelta`). Pure index addition
    //      on existing rows — no upgrade hook needed.
    this.version(61).stores({
      syncTombstones: "[table+id], table, deletedAt",
      messages: "id, sessionId, [sessionId+createdAt], senderId, platformMessageId, [createdAt+id]",
    })

    // v62 — Workspaces. The `useProjectStore` project model gains durable
    // persistence (was in-memory only). One row per workspace, keyed by `id`;
    // `lastAccessedAt` indexed for recency ordering. The active-workspace
    // pointer lives on the settings singleton, not here. See
    // `lib/db/projects.ts`. Additive — no upgrade hook.
    this.version(62).stores({
      projects: "&id, isArchived, lastAccessedAt",
    })

    // v63 — Drop the `isArchived` index. `isArchived` is a JS boolean, and
    // IndexedDB cannot index boolean keys (only number/string/Date/binary and
    // arrays of those), so the index never populated — a `where("isArchived")`
    // query would silently match nothing. All callers already filter archived
    // state in memory (`getAllProjects().filter(...)`), so this just removes a
    // dead, footgun index. Data is preserved; only the index definition changes.
    this.version(63).stores({
      projects: "&id, lastAccessedAt",
    })

    // v64 — Agent evaluation subsystem. Additive only; no upgrade hook (no
    // pre-existing rows carry these shapes). Indexes:
    //   • evalDatasets    — `&id` primary; `capability` for the per-capability
    //                       dataset list; `updatedAt` for newest-first sort.
    //   • evalCases       — `&id` primary; `datasetId` + `[datasetId+createdAt]`
    //                       for in-order per-dataset listing; `capability` and
    //                       `failureMode` for the error-analysis filters;
    //                       `sourceTraceId` to dedupe "save as eval case".
    //   • evalRuns        — `&runId` primary (the report IS the row); `datasetId` +
    //                       `[datasetId+createdAt]` for the per-dataset trend
    //                       chart; `createdAt` for the global recent-runs view.
    //   • traceAnnotations— `&id` primary; `traceId` (one annotation per trace)
    //                       and `sessionId` for the panel; `failureMode` for the
    //                       taxonomy roll-up; `createdAt` for newest-first.
    this.version(64).stores({
      evalDatasets: "&id, capability, updatedAt, createdAt",
      evalCases: "&id, datasetId, [datasetId+createdAt], capability, failureMode, sourceTraceId",
      evalRuns: "&runId, datasetId, [datasetId+createdAt], createdAt",
      traceAnnotations: "&id, &traceId, sessionId, failureMode, createdAt",
    })

    // v65 — Autonomous long-term memory. Additive only; no upgrade hook (no
    // pre-existing rows carry this shape). One table holds all three memory
    // types (semantic/episodic/procedural). Indexes:
    //   • `scope` / `type` / `characterId`     — panel grouping + scope-union retrieval.
    //   • `status`                             — retrieval filters to `active` only.
    //   • `lastAccessedAt`                     — recency factor + access-time expiry.
    //   • `vectorDocId`                        — reverse lookup on vector cleanup.
    //   • `sourceSessionId`                    — provenance "jump to source".
    //   • `pinned`                             — eviction exemption.
    //   • `[scope+type]` / `[scope+status]` / `[type+status]` — composite reads.
    // See `lib/db/memories.ts` and `@/types/memory/memory`.
    this.version(65).stores({
      memories:
        "&id, scope, type, characterId, status, lastAccessedAt, vectorDocId, sourceSessionId, pinned, [scope+type], [scope+status], [type+status]",
    })

    // v66 — Multi-root workspaces. `Project.roots` becomes the source of truth;
    // backfill it from the legacy rootDir/additionalDirs mirrors. Store string
    // unchanged (`roots` lives in the row, not indexed).
    this.version(66)
      .stores({ projects: "&id, lastAccessedAt" })
      .upgrade(async (tx) => {
        await tx
          .table("projects")
          .toCollection()
          .modify((p) => {
            backfillRootsForRow(p as Project)
          })
      })

    // v67 — Pet subsystem (virtual companion). Additive only; no upgrade hook.
    //   • petProfile           — singleton (id="global"); identity Soul + nurture state.
    //   • petCharacterBindings — per-Character appearance override, keyed by characterId.
    //   • petActivityLog       — append-only XP/interaction ledger (auto-id), pruned by
    //                            `lib/db/pet.ts`. `[kind+ts]` powers achievement counters.
    //   • petAchievements      — unlock records keyed by achievement id.
    // See `lib/db/pet.ts` and `@/types/pet`.
    this.version(67).stores({
      petProfile: "&id",
      petCharacterBindings: "&characterId, updatedAt",
      petActivityLog: "++id, kind, ts, [kind+ts]",
      petAchievements: "&id, unlockedAt",
    })

    // v68 — Unified Notification Center (ADR-0042). Additive only; no upgrade
    // hook. The durable in-app "center" record for every notification, fed by
    // the single `lib/notifications/notify()` pipe (scheduler, agent-team,
    // plugin, connector, session, push all funnel here). Preferences ride on
    // the AppSettings singleton (`notificationPreferences`), NOT this table.
    //   • dedupeKey  — coalescing key (bump existing `count` within window).
    //   • groupKey   — feed grouping (e.g. conversationKey, runId).
    //   • [readState+createdAt] — newest-unread feed queries + badge counts.
    //   • [source+createdAt]    — per-source filtering, newest-first.
    // See `lib/db/notifications.ts` and `@/types/notifications`.
    this.version(68).stores({
      notifications:
        "&id, createdAt, updatedAt, source, level, readState, dedupeKey, groupKey, snoozedUntil, expiresAt, [readState+createdAt], [source+createdAt]",
    })

    // v69 — Eval datasets/runs/compare extension. Additive; no upgrade hook.
    //   • evalDatasetVersions — immutable snapshot per dataset version
    //     (Approach A). `[datasetId+version]` for "latest snapshot for version"
    //     lookup, `tag` for tagged-version lookup.
    //   • evalRunCaseResults  — compact per-case verdict per run, feeding the
    //     A-vs-B comparison grid. `[runId+caseId]` is the natural unique read.
    // See `./eval-dataset-versions.ts` and `./eval-run-cases.ts`.
    this.version(69).stores({
      evalDatasetVersions: "&id, datasetId, [datasetId+version], tag, createdAt",
      evalRunCaseResults: "&id, runId, [runId+caseId], caseId",
    })

    // v70 — Subscription balance snapshots (ADR-0025 Phase 3). Additive; no
    // upgrade hook. One row per `queryAccountBalance` result, capped at 500
    // newest-first by `lib/subscription/balance/store.ts`.
    //   • [providerKey+accountId] — latest snapshot per account+adapter.
    // See `lib/subscription/balance/` and `@/types/subscription`.
    this.version(70).stores({
      subscriptionBalance: "++localId, fetchedAt, accountId, [providerKey+accountId]",
    })

    // v71 — Unified Plan Execution Hub (ADR-0045). Additive; no upgrade hook.
    // Indices mirror `chatGoals` / `chatGoalEvents` (v30):
    //   • agentPlans       — `&id` primary; `[sessionId+status]` for the
    //     one-open-plan-per-session lookup; `sessionId` for the per-session
    //     history; `createdAt`/`updatedAt` for sorting.
    //   • agentPlanEvents  — `&id` primary; `planId` for cascade-delete;
    //     `[planId+ts]` for the newest-first audit trail; `kind` for filtering.
    // See `lib/db/plans.ts` and `@/types/agent/plan`.
    this.version(71).stores({
      agentPlans: "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt",
      agentPlanEvents: "&id, planId, [planId+ts], kind, ts",
    })

    // ── v72 — Remote-control durable audit trail (ADR-0005 activation). ──────
    // One row per inbound command dispatch and per outbound delivery attempt.
    // `at` drives the newest-first Events tab; `direction`/`kind` filter.
    // See `lib/db/remote-control-audit.ts` and `@/types/remote-control`.
    this.version(72).stores({
      remoteControlAudit: "id, at, direction, kind, runId",
    })

    // ── v73 — Pet Live2D model storage (Live2D skin engine). ─────────────────
    // Imported / sample-downloaded Live2D models live in two tables:
    //   • petModels      — `&id` primary; one row per model with capability
    //     metadata (motion groups / expressions) for state mapping. `name`,
    //     `createdAt`, `source` index the list/sort/filter surfaces.
    //   • petModelFiles  — `&id` (`${modelId}:${path}`) primary; one row per
    //     model asset blob. `modelId` drives cascade-delete; `[modelId+path]`
    //     gives O(1) per-file lookup for the runtime URL resolver.
    // Additive; no upgrade hook. See `lib/db/pet-models.ts`.
    this.version(73).stores({
      petModels: "&id, name, createdAt, source",
      petModelFiles: "&id, modelId, [modelId+path]",
    })

    // ── v74 — Terminal: durable history + unattended-exec audit. ─────────────
    //   • terminalHistory     — cross-session command history feeding the
    //     autocomplete history provider (ADR-0039 phase 2). One row per
    //     `(projectId, command)`; re-runs bump `ts`/`uses`. `command` indexes
    //     the prefix query; `ts` drives LRU pruning (cap 5000). `projectId`
    //     is `""` (never null) for project-less rows — IndexedDB compound
    //     keys cannot contain null. See `lib/db/terminal-history.ts`.
    //   • unattendedExecAudit — one row per unattended terminal execution
    //     (or block), the durable trail for the consent-replacement policy.
    //     `ts` newest-first; `runId` filters per workflow run. See
    //     `lib/db/terminal-audit.ts`.
    // Additive; no upgrade hook.
    this.version(74).stores({
      terminalHistory: "&id, ts, command, [projectId+command]",
      unattendedExecAudit: "&id, ts, runId",
    })

    // ── v75 — Persistent provider cost rollups (routing daily budgets). ──────
    // One row per `(local day, providerId, modelId)`, upsert-incremented from
    // `recordProviderOutcome`. `day` drives the boot hydration of the budget
    // mirror + 90-day pruning; `[providerId+day]` serves per-provider history.
    // Additive; no upgrade hook. See `lib/db/provider-cost-daily.ts`.
    this.version(75).stores({
      providerCostDaily: "&id, day, providerId, [providerId+day], updatedAt",
    })

    // ── v76 — Semantic tool routes (semantic-router analog). ─────────────────
    // One row per route: example utterances (+ cached vectors) attached to a
    // tool or a whole plugin, consumed by `lib/ai/routing/semantic-tool-router`
    // to prune the exposed plugin-tool manifest when the opt-in setting is on.
    // `refId` serves per-tool lookups; `pluginId` serves manifest-route cleanup
    // on plugin disable. Additive; no upgrade hook. See `lib/db/tool-routes.ts`.
    this.version(76).stores({
      toolRoutes: "&id, refId, kind, enabled, pluginId",
    })

    // ── v77 — Pet rolling conversation history (talked LLM side channel). ────
    // One row per completed talk turn; pruned to the newest 200 on append.
    // Proactive utterances are skip-memory and never stored. Additive; no
    // upgrade hook. See `lib/db/pet-conversation.ts`.
    this.version(77).stores({
      petConversation: "++id, at",
    })

    // ── v78 — Detach skills installed from the defunct "SkillsMP" source. ────
    // The speculative SkillsMP marketplace adapter was replaced by the real
    // skills.sh integration; its canonicalId scheme (`skillsmp:<id>`) can
    // never match the new `skillssh:owner/repo/slug` ids. Clearing the
    // provenance fields turns those rows into plain local skills (they keep
    // working) instead of phantom marketplace installs whose "installed"
    // badge and update checks would silently never resolve. Idempotent: only
    // rows whose canonicalId carries the `skillsmp:` prefix are touched.
    this.version(78)
      .stores({})
      .upgrade(async (tx) => {
        await tx
          .table("skills")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.canonicalId === "string" && row.canonicalId.startsWith("skillsmp:")) {
              row.canonicalId = undefined
              row.marketplaceSkillId = undefined
            }
          })
      })

    // ── v79 — /loop command (recurring prompts). ─────────────────────────────
    // `loops` mirrors `chatGoals` (session-scoped, `[sessionId+status]` for
    // the one-active-per-session invariant; `scheduledTaskId` links interval
    // loops to their backing scheduler task). `loopEvents` mirrors
    // `chatGoalEvents` (append-only, capped per loop at the CRUD layer).
    // Additive; no upgrade hook. See `lib/db/loops.ts` and `@/types/loop`.
    this.version(79).stores({
      loops: "&id, sessionId, [sessionId+status], status, mode, scheduledTaskId, createdAt",
      loopEvents: "&id, loopId, [loopId+ts], kind, ts",
    })
    // v80 — composer sent-message history (↑/↓ recall). Pure additive.
    this.version(80).stores({
      chatInputHistory: "++id, sessionId, [sessionId+createdAt]",
    })
    // v81 — conversation branching lineage. Adds the `parentSessionId` index to
    // `sessions` so a branched session can find its parent (and a parent its
    // children) for the lightweight "branched from" indicator. The branch
    // payload fields (`branchedFromMessageId`, `branchKind`, `branchSeed`) are
    // non-indexed and need no store change. Additive; no upgrade hook (legacy
    // rows simply have `parentSessionId === undefined`). See
    // `lib/chat/branch-session.ts`.
    this.version(81).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId, parentSessionId",
    })

    // v82 — Judge calibration loop (eval spec §10).
    //   • calibrationItems — `id` primary; `setId` + `[setId+createdAt]` for the
    //     per-set listing; `criterion`/`sourceTraceId`/`sourceCaseId` for lookups.
    //   • calibrationRuns  — `runId` primary (the agreement report IS the row);
    //     `setId` + `[setId+createdAt]` drive κ-over-time history.
    this.version(82).stores({
      calibrationItems:
        "id, setId, criterion, [setId+createdAt], sourceTraceId, sourceCaseId, createdAt",
      calibrationRuns: "runId, setId, [setId+createdAt], createdAt",
    })

    // v83 — Connector CRM maturation (Chatwoot-style inbox).
    //   • conversationOverrides — adds lifecycle `status` (+ `[status+updatedAt]`
    //     for status-filtered listing), multi-entry `*labelIds`,
    //     `nextResponseDueAt` (overdue queries), and the `assigneeKind`
    //     discriminator. Other CRM fields (snoozeUntil, assignee blob, SLA
    //     timestamps) are non-indexed and need no index entry. Full index
    //     string repeats the v19 set because Dexie replaces, not merges, a
    //     table's index list.
    //   • conversationLabels — reusable label catalog.
    //   • conversationAssignmentEvents — append-only status/assign/label trail,
    //     `[conversationKey+at]` for the per-conversation timeline.
    //   • cannedResponses — global saved-reply library with `*labelIds`.
    // Pure additive — no upgrade callback (readers default the new fields).
    this.version(83).stores({
      conversationOverrides:
        "&id, &conversationKey, sessionId, pinned, archived, updatedAt, status, [status+updatedAt], *labelIds, nextResponseDueAt, assigneeKind",
      conversationLabels: "&id, name, builtin, sortOrder, updatedAt",
      conversationAssignmentEvents: "&id, conversationKey, [conversationKey+at], kind, at",
      cannedResponses: "&id, title, category, isBuiltIn, sortOrder, updatedAt, *labelIds",
    })

    // v84 — Unified provider limits/usage snapshots (ADR-0025 follow-up). One
    // capped table feeding both the TUI `/limits` panel and the desktop Usage
    // tab for every subscription provider, not just Anthropic. Pure additive.
    this.version(84).stores({
      providerLimits: "++localId, fetchedAt, provider, accountId, [provider+accountId]",
    })

    // v85 — IM control-plane: multi-session per conversation. Adds the
    // denormalized `platformConversationKey` index to `sessions` so the
    // connector runtime can enumerate every session bound to one IM
    // conversation (`/new` / `/switch` / `/sessions`) without a full-table
    // scan. The upgrade hook backfills the new column from each row's existing
    // `platformBinding.conversationKey`. Full index string repeats the v81 set
    // because Dexie replaces, not merges, a table's index list. The new
    // ConversationOverrideRow fields (reasoningOverride, activeSessionId,
    // teamId, approvalMode, proactivePush) are non-indexed and need no store
    // change — readers default the absent values.
    this.version(85)
      .stores({
        sessions:
          "id, updatedAt, createdAt, kind, characterId, teamId, parentSessionId, platformConversationKey",
      })
      .upgrade(async (tx) => {
        await tx
          .table("sessions")
          .toCollection()
          .modify((session: ChatSession) => {
            const key = session.platformBinding?.conversationKey
            if (key && session.platformConversationKey === undefined) {
              session.platformConversationKey = key
            }
          })
      })

    // v86 — Workspace (Project) data isolation. Adds a `projectId` scalar +
    // compound index to every runtime/working-state table so chat sessions,
    // messages, goals/plans/loops, agent traces, canvas docs, workflow runs,
    // and connector routing/draft/audit rows are partitioned per workspace.
    // Connector CONFIG (`adapterInstances`/`platformIdentities`), the global
    // inbound dedup `inboundLedger`, attachment cache, and heartbeats stay
    // profile-level shared and gain no column. Workflow DEFINITIONS
    // (`workflows`) stay shared too — only their `workflowRuns` history is
    // scoped. The upgrade backfills via the legacy `Project.sessionIds[]`
    // reverse map (faithful for multi-project users), falling back to the
    // active project — or an auto-created Default workspace when none is set.
    // Index strings repeat each table's full prior set because Dexie replaces,
    // not merges, a table's index list. See `lib/db/project-scope.ts`.
    this.version(86)
      .stores({
        sessions:
          "id, updatedAt, createdAt, kind, characterId, teamId, parentSessionId, platformConversationKey, projectId, [projectId+updatedAt]",
        messages:
          "id, sessionId, [sessionId+createdAt], senderId, platformMessageId, [createdAt+id], projectId, [projectId+createdAt]",
        chatGoals:
          "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt, projectId, [projectId+createdAt]",
        chatGoalEvents: "&id, goalId, [goalId+ts], kind, ts, projectId",
        agentPlans:
          "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt, projectId, [projectId+createdAt]",
        agentPlanEvents: "&id, planId, [planId+ts], kind, ts, projectId",
        loops:
          "&id, sessionId, [sessionId+status], status, mode, scheduledTaskId, createdAt, projectId, [projectId+createdAt]",
        loopEvents: "&id, loopId, [loopId+ts], kind, ts, projectId",
        agentTraces:
          "&id, sessionId, [sessionId+startTime], traceId, [traceId+startTime], parentSpanId, surface, projectId, [projectId+startTime]",
        canvasDocuments:
          "id, title, language, type, updatedAt, createdAt, projectId, [projectId+updatedAt]",
        canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave, projectId",
        canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt, projectId",
        canvasSessions: "id, documentId, ownerId, createdAt, projectId",
        workflowRuns:
          "&id, workflowId, status, startedAt, completedAt, [workflowId+startedAt], [workflowId+status], projectId, [projectId+startedAt]",
        workflowRunEvents: "&id, runId, [runId+ts], stepId, [runId+stepId], type, projectId",
        outboundQueue:
          "&id, conversationKey, [conversationKey+createdAt], status, nextAttemptAt, idempotencyKey, [adapterId+status], createdAt, [status+nextAttemptAt], projectId, [projectId+status]",
        connectorDrafts:
          "&id, conversationKey, sessionId, [conversationKey+createdAt], status, expiresAt, projectId",
        connectorAudit:
          "&id, adapterId, kind, at, [adapterId+at], [adapterId+kind+at], projectId, [projectId+at]",
        conversationOverrides:
          "&id, &conversationKey, sessionId, pinned, archived, updatedAt, status, [status+updatedAt], *labelIds, nextResponseDueAt, assigneeKind, projectId",
      })
      .upgrade(backfillProjectScopeV86)

    // v87 — Journaled background subagent tasks. Pure additive; running rows
    // are reconciled to `interrupted` by the host boot code, not by migration.
    this.version(87).stores({
      backgroundTasks:
        "&runId, kind, subagentId, sessionId, host, status, startedAt, settledAt, [host+status], [sessionId+startedAt]",
    })

    // v88 — WASM preopen grant ledger. Pure additive; grant reconciliation is
    // handled by `lib/plugin/security/wasm-grant.ts` at load/call time.
    this.version(88).stores({
      wasmGrantLedger: "&id, pluginId, preopen, source, grantedAt",
    })

    // v89 — Per-turn Run Records (Run Panel "second clock"). Pure additive;
    // a row with no `settledAt` on reload is shown as "interrupted". See
    // `lib/db/run-records.ts`.
    this.version(89).stores({
      runRecords: "[sessionId+runId], sessionId, [sessionId+startedAt], startedAt, status",
    })

    // v90 — Conversation folders (conversation-list overhaul). A lightweight,
    // workspace-scoped folder dimension orthogonal to the workspace itself;
    // sessions reference a folder via the non-indexed `ChatSession.folderId`.
    // Pure additive — no upgrade hook. See `lib/db/session-folders.ts`.
    this.version(90).stores({
      sessionFolders: "id, projectId, [projectId+order], name, createdAt, updatedAt",
    })
  }

  sessionState!: Table<SessionStateRow, string>
  tts_provider_keys!: Table<TtsProviderKeyRow, string>
  openVsxCache!: Table<OpenVsxCacheRow, string>
  vscodeExtensionRuntime!: Table<VscodeExtensionRuntimeRow, string>
  // v44 — companion sync cursors (Wave 4 / ADR-0026). See `lib/sync/types.ts`.
  syncCursors!: Table<SyncCursorRow, string>
  // v62 — Workspaces (project model persistence). See `lib/db/projects.ts`.
  projects!: Table<Project, string>
  // v65 — Autonomous long-term memory. See `lib/db/memories.ts`.
  memories!: Table<Memory, string>
  // v61 — companion sync tombstones (deletions). See `lib/sync/tombstones.ts`.
  syncTombstones!: Table<SyncTombstoneRow, [SyncableTable, string]>
  // v49 — Inbox telemetry ring buffer (cap 3000). See `lib/db/inbox-telemetry.ts`.
  inboxTelemetryEvents!: Table<InboxTelemetryEventRow, string>
  // v57 — Computer-Use sandbox connections. See `lib/db/sandbox-connections.ts`.
  sandboxConnections!: Table<SandboxConnectionRow, string>
  // v59 — GitHub marketplace-repo sources. See `lib/db/plugin-marketplace-sources.ts`.
  pluginMarketplaceSources!: Table<PluginMarketplaceSourceRow, string>
  // v60 — models.dev catalog cache (singleton). See `lib/db/models-dev-catalog.ts`.
  modelsDevCatalog!: Table<ModelsDevCatalogRow, string>
  // v67 — Pet subsystem. See `lib/db/pet.ts` and `@/types/pet`.
  petProfile!: Table<PetProfile, "global">
  petCharacterBindings!: Table<PetCharacterBinding, string>
  petActivityLog!: Table<PetActivityRow, number>
  petAchievements!: Table<PetAchievementRecord, string>
  // v72 — Remote-control durable audit. See `lib/db/remote-control-audit.ts`.
  remoteControlAudit!: Table<RemoteControlAuditEntry, string>
  // v73 — Pet Live2D models + asset blobs. See `lib/db/pet-models.ts`.
  petModels!: Table<PetModelRow, string>
  petModelFiles!: Table<PetModelFileRow, string>
  // v74 — Terminal durable history + unattended-exec audit.
  terminalHistory!: Table<TerminalHistoryRow, string>
  unattendedExecAudit!: Table<UnattendedExecAuditRow, string>
  // v75 — Provider cost rollups. See `lib/db/provider-cost-daily.ts`.
  providerCostDaily!: Table<ProviderCostDailyRow, string>
  // v76 — Semantic tool routes. See `lib/db/tool-routes.ts`.
  toolRoutes!: Table<import("@/types/routing/tool-route").ToolRouteRecord, string>
  // v77 — Pet conversation history. See `lib/db/pet-conversation.ts`.
  petConversation!: Table<PetConversationRow, number>
}

// Row types for these tables live next to their CRUD module (or a dedicated
// `*-types.ts` file) per `lib/db/CONVENTIONS.md`. They are re-exported here so
// `@/lib/db/schema` remains the stable import surface for existing call sites.
export type { ModelsDevCatalogRow } from "./models-dev-catalog"
export type { SessionStateRow } from "./session-state"
export type { TrustedPublisherRow } from "./trusted-publishers"
export type { TtsProviderKeyRow } from "@/types/media/tts"
export type {
  OpenVsxCacheRow,
  VscodeExtensionRuntimeRow,
} from "@/types/plugin/vscode-extension-cache"
export type { AutomationAuditLogRow } from "@/lib/automation/audit"
export type { WorkflowViewportBookmarkRow } from "@/lib/workflow/editor/viewport-bookmarks-db"
export type { PluginDexieMeta } from "./plugin-types"
export type { EvalRunRow } from "./eval-runs"
export type { TraceAnnotationRow } from "./trace-annotations"
export type { CalibrationItemRow } from "./calibration-items"
export type { CalibrationRunRow, CalibrationVerdict } from "./calibration-runs"
export type { BackgroundTaskJournalRow } from "./background-tasks"
export type { WasmGrantLedgerRow, WasmGrantSource } from "./wasm-grant-ledger"
export type { RunRecordRow } from "./run-records"
export type { PetModelRow, PetModelFileRow } from "./pet-models"
export type { TerminalHistoryRow } from "./terminal-history"
export type { ProviderCostDailyRow } from "./provider-cost-daily"
export type { UnattendedExecAuditRow } from "./terminal-audit"
export type {
  ConversationLabelRow,
  ConversationAssignmentEventRow,
  AssignmentEventKind,
  CannedResponseRow,
} from "./crm-types"

let _db: CogniaDB | null = null
let _seedPromise: Promise<void> | null = null
let _activeDatabaseName: string | null = null

export function activateAccountDatabase(accountId: string): void {
  const nextName = accountDatabaseName(accountId)
  if (_activeDatabaseName === nextName && _db?.name === nextName) return
  _activeDatabaseName = nextName
  closeCachedDb()
}

export function clearAccountDatabaseSelection(): void {
  if (_activeDatabaseName === null && _db?.name === LEGACY_COGNIA_DB_NAME) return
  _activeDatabaseName = null
  closeCachedDb()
}

export function getDb(): CogniaDB {
  // SSR-safe: only instantiate Dexie on the client. Static export still
  // pre-renders pages where `window` is undefined, so we lazy-create.
  if (typeof window === "undefined") {
    throw new Error("getDb() called on the server — wrap usage in a client component")
  }
  if (!_db) {
    _db = new CogniaDB(_activeDatabaseName ?? LEGACY_COGNIA_DB_NAME)
    const seedTarget = _db
    // Kick off seeding once per process. We import lazily to avoid a circular
    // dependency: seed.ts imports the per-table CRUD modules which import this
    // file. The promise is memoized so concurrent callers share the same run.
    _seedPromise = import("./seed")
      .then(({ seedBuiltIns }) => {
        if (_db !== seedTarget) return
        return seedBuiltIns()
      })
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
  _activeDatabaseName = null
  closeCachedDb()
}

function closeCachedDb(): void {
  _db?.close()
  _db = null
  _seedPromise = null
}
