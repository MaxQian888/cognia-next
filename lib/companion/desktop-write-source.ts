"use client"

/**
 * Host-side counterpart of the Rust `companion::desktop_writes_bridge`.
 *
 * A remote client (phone, web companion, or a desktop driving another host)
 * calls `_rpc/<command>` on this host's Rust HTTP server. Rust round-trips the
 * call through one unified `companion://desktop-write-request` event carrying
 * `{ requestId, command, payload }`; this module dispatches by command name,
 * runs the matching Dexie / store / runtime operation, and ships the result
 * back via the `companion_desktop_write_response` Tauri command.
 *
 * Installed by BOTH hosts, so one implementation serves both:
 *   - desktop renderer — `components/providers/desktop-message-source-provider.tsx`
 *   - headless brain   — `lib/headless/runtimes/desktop-message-source.ts`
 *
 * The command surface is not a fixed list. `dispatchCommand` owns the arms
 * enumerated in its own switch and delegates three families wholesale:
 * `perf_*` (`lib/perf/host-dispatch.ts`), `scheduled_task_*`
 * (`lib/scheduler/scheduled-task-rpc.ts`), and `workflow_api_*`
 * (`lib/workflow/api/workflow-api-service.ts`).
 *
 * The authoritative routing table lives on the Rust side — a command only
 * reaches here if one of these dispatches it to the writes bridge:
 *   - `src-tauri/src/companion_api/rpc/data_sync.rs` (the bulk of the surface)
 *   - `src-tauri/src/companion_api/rpc/service_plane.rs` (`app_settings_update`)
 *   - `src-tauri/src/companion_api/workflow_api.rs` (`workflow_api_*`)
 * An arm with no counterpart there is unreachable; a Rust route with no arm
 * here fails with `unknown desktop-write command`.
 *
 * Modeled after `lib/companion/desktop-message-source.ts` — same install
 * guard, same bridge-injection pattern for tests.
 *
 * Tests are split by concern, not by release:
 *   - `desktop-write-source.test.ts` — real Dexie (`fake-indexeddb`), behavior
 *   - `desktop-write-source.dispatch-contract.test.ts` — mocked backends, routing
 *   - `desktop-write-source.workflow-api.test.ts` — the `workflow_api_*` delegation
 */

import { parseAdapterPolicyRelay } from "@/lib/connectors/adapter-policy-relay"
import { updateAdapterConfigSection } from "@/lib/db/adapter-instances"
import { createCharacter, deleteCharacter, updateCharacter } from "@/lib/db/characters"
import type { CharacterDraft } from "@/lib/db/characters"
import { isConnectorRuntimeOwnedHere } from "@/lib/connectors/bootstrap/install-connector-runtime"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { attachSession, detachSession } from "@/lib/companion/remote-attach-registry"
import {
  abortAttachmentUpload,
  appendAttachmentChunk,
  beginAttachmentUpload,
  commitAttachmentUpload,
} from "@/lib/db/session-attachment-uploads"
import {
  ATTACH_LEASE_RENEW_INTERVAL_MS,
  ATTACH_LEASE_TTL_MS,
  type AttachMode,
  type EventStreamConnection,
} from "@/lib/companion/device-presence-registry"
import {
  handleTeamRunPause,
  handleTeamRunResume,
  handleTeamRunStop,
  handleTeamTaskComment,
  handleTeamTaskCreate,
  handleTeamTaskMove,
} from "@/lib/companion/agent-team-write-handlers"
import {
  handleAgentTaskCancel,
  handleAgentTaskComment,
  handleAgentTaskMove,
  handleAgentTaskPause,
  handleAgentTaskResume,
  handleAgentTaskStart,
} from "@/lib/companion/agent-task-write-handlers"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { getDb } from "@/lib/db/schema"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getSettings, saveSettings } from "@/lib/db/settings"
import type { AppSettings, StoredMessage } from "@cognia/agent-config-types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { enqueueIngestJob, registerTwinSource } from "@/lib/twin/ingest"
import { stageFile } from "@/lib/twin/ingest/stage"
import { reviewTwinDraft } from "@/lib/twin/review-draft"
import { removeTwin, removeTwinSource } from "@/lib/twin/lifecycle"
import { dispatchTrigger, isTriggerEvent } from "@/lib/workflow/runtime/trigger-bridge"
import { isCapabilityId } from "@/lib/platform/capabilities"
import { recordDeviceCapabilities } from "@/lib/db/paired-devices"
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflowRuns,
  updateWorkflow,
  type WorkflowDraft,
  type WorkflowPatch,
} from "@/lib/db/workflows"
import { createWorkflowSource } from "@/lib/scheduler/sources/workflow-source"
import { dispatchScheduledTaskRpc, isScheduledTaskRpc } from "@/lib/scheduler/scheduled-task-rpc"
import { createTwin, type TwinInput } from "@/lib/db/twins"
import {
  listTwinSourcesByTwin,
  updateTwinSource,
  type TwinSourceDraft,
} from "@/lib/db/twin-sources"
import {
  addEntity,
  addPlaybook,
  addStyleSample,
  removeEntity,
  removePlaybook,
  removeStyleSample,
  resetTwinProfile,
  setEntityPinned,
  setPlaybookPinned,
  setStyleSamplePinned,
  setVoiceSummary,
  updateEntity,
  updatePlaybook,
  updateStyleSample,
} from "@/lib/db/twin-profile"
import { getActiveGoalForSession, getGoal, listGoalsBySession } from "@/lib/db/goals"
import type { GoalConfig } from "@/types/goal"
import type { Playbook, ProfileEntity, StyleSample, TwinSource } from "@/types/twin"
import {
  cancelJob,
  getTwinJob,
  listActiveJobsByTwin,
  pauseJob,
  resumeJob,
  retryDeadLetterJob,
} from "@/lib/db/twin-jobs"
import {
  upsertByConversationKey,
  type ConversationOverrideInput,
} from "@/lib/db/conversation-overrides"
import { buildBackupPackage } from "@/lib/data/build-package"
import { applyBackupPackage } from "@/lib/data/apply-package"
import type {
  BackupPackageV3,
  ExportOptions,
  ImportOptions,
  ImportMergeStrategy,
} from "@/lib/data/types"
import { adaptPermissionMode } from "@/lib/ai/agent/external/permission-modes"
import { createProfileDekStore } from "@/lib/rag/profile-dek-store"
import type {
  AcpPermissionMode,
  ExternalAgentProtocol,
  UpdateExternalAgentInput,
} from "@/types/agent/external-agent"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import { markSessionDirty } from "@/lib/chat/search/indexer"
import { transport } from "@/lib/tauri"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import {
  createAgentRpcHostStateDispatcher,
  createHostStateService,
  type HostStateService,
} from "@/lib/sync/host-state-service"
import { permittedHostStateIntentKinds } from "@cognia/agent-config-types/host-state"
import type {
  HostStateSnapshotRequest,
  HostStateSubmitCaller,
  HostStateSubmitRequest,
} from "@cognia/agent-config-types/host-state"
import { isAgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

const REQUEST_EVENT = "companion://desktop-write-request"
const RESPONSE_COMMAND = "companion_desktop_write_response"

interface DesktopWriteRequestEvent {
  requestId: string
  command: string
  payload: Record<string, unknown>
}

/** Tiny Tauri shape so the file types-check in pure-web tests too. */
interface TauriBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
}

let installed = false
let hostStateAuthority: { key: string; service: HostStateService } | null = null
let hostStateProjection = Promise.resolve()
const hostStateOwnerId = `brain-${crypto.randomUUID()}`
const hostStateRuntimeDispatcher = createAgentRpcHostStateDispatcher()

export interface InstallOptions {
  bridge?: TauriBridge
  forceReinstall?: boolean
}

export async function installDesktopWriteSource(opts: InstallOptions = {}): Promise<() => void> {
  if (installed && !opts.forceReinstall) return () => {}
  installed = true

  let bridge: TauriBridge
  if (opts.bridge) {
    bridge = opts.bridge
  } else {
    try {
      bridge = { listen, invoke }
    } catch {
      installed = false
      return () => {}
    }
  }

  const unlisten = await bridge.listen<DesktopWriteRequestEvent>(REQUEST_EVENT, (event) => {
    void respond(event.payload, bridge)
  })
  const unsubscribeAgentEvents = transport.subscribe<{ envelope?: unknown }>(
    "agent://message",
    (payload) => {
      const authority = hostStateAuthority
      const envelope = payload?.envelope
      if (!authority || !isAgentEventEnvelope(envelope)) return
      hostStateProjection = hostStateProjection
        .then(() => authority.service.projectRuntimeEnvelope(envelope))
        .then(() => undefined)
        .catch(() => undefined)
    }
  )

  return () => {
    installed = false
    unlisten()
    unsubscribeAgentEvents()
  }
}

async function respond(req: DesktopWriteRequestEvent, bridge: TauriBridge): Promise<void> {
  const { requestId, command, payload } = req
  try {
    const result = await dispatchCommand(command, payload, bridge)
    await bridge.invoke(RESPONSE_COMMAND, { requestId, result, error: null })
  } catch (err: unknown) {
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Exposed for tests — production callers go through the listener above. */
export async function dispatchCommand(
  command: string,
  payload: Record<string, unknown>,
  bridge?: TauriBridge
): Promise<unknown> {
  const { isPerformanceHostCommand, dispatchPerformanceHostCommand } =
    await import("@/lib/perf/host-dispatch")
  if (isPerformanceHostCommand(command)) {
    return dispatchPerformanceHostCommand(command, payload)
  }
  if (
    command === "workflow_api_run_create" ||
    command === "workflow_api_run_get" ||
    command === "workflow_api_events_list" ||
    command === "workflow_api_run_cancel"
  ) {
    const { dispatchWorkflowApiBridgeCommand } =
      await import("@/lib/workflow/api/workflow-api-service")
    return dispatchWorkflowApiBridgeCommand(command, payload)
  }
  if (
    command === "workflow_app_bootstrap" ||
    command === "workflow_app_run_create" ||
    command === "workflow_app_run_get" ||
    command === "workflow_app_events_list" ||
    command === "workflow_app_run_cancel" ||
    command === "workflow_app_chat_message" ||
    command === "workflow_app_feedback_submit" ||
    command === "workflow_app_mcp" ||
    command === "workflow_app_batch_template" ||
    command === "workflow_app_batch_create" ||
    command === "workflow_app_batch_get" ||
    command === "workflow_app_batch_pause" ||
    command === "workflow_app_batch_resume" ||
    command === "workflow_app_batch_cancel" ||
    command === "workflow_app_batch_export" ||
    command === "workflow_app_human_input_list" ||
    command === "workflow_app_human_input_submit" ||
    command === "workflow_app_human_input_file_upload"
  ) {
    const { dispatchPublicWorkflowAppBridgeCommand } =
      await import("@/lib/workflow/apps/public-app-service")
    return dispatchPublicWorkflowAppBridgeCommand(command, payload)
  }
  if (
    command === "dify_workflow_run" ||
    command === "dify_workflow_status" ||
    command === "dify_events_list" ||
    command === "dify_task_stop" ||
    command === "dify_chat_message" ||
    command === "dify_conversations_list" ||
    command === "dify_messages_list" ||
    command === "dify_conversation_rename" ||
    command === "dify_conversation_delete" ||
    command === "dify_conversation_variables" ||
    command === "dify_message_feedback" ||
    command === "dify_file_upload"
  ) {
    const { dispatchDifyBridgeCommand } = await import("@/lib/workflow/apps/dify-bridge-service")
    return dispatchDifyBridgeCommand(command, payload)
  }
  if (isScheduledTaskRpc(command)) {
    return dispatchScheduledTaskRpc(command, payload)
  }
  // Browser Companion. Its own module rather than four `case` arms because the
  // submit path creates a session and enqueues a turn — see
  // `lib/browser-companion/host-dispatch.ts` for why it needs the HostState
  // authority and why it is handed in rather than reached for.
  const { isBrowserCompanionCommand, dispatchBrowserCompanionCommand } =
    await import("@/lib/browser-companion/host-dispatch")
  if (isBrowserCompanionCommand(command)) {
    return dispatchBrowserCompanionCommand(command, payload, (request) =>
      resolveHostStateService(request, bridge)
    )
  }
  switch (command) {
    case "character_upsert":
      return characterUpsert(payload)
    case "character_delete":
      return characterDelete(payload)
    case "character_bind_twin":
      return characterBindTwin(payload)
    case "skill_set_enabled":
      return skillSetEnabled(payload)
    case "plugin_set_enabled":
      return pluginSetEnabled(payload)
    case "mcp_set_enabled":
      return mcpSetEnabled(payload)
    case "mcp_set_tool_rules":
      return mcpSetToolRules(payload)
    case "adapter_update_policy":
      return adapterUpdatePolicy(payload)
    case "app_settings_update":
      return appSettingsUpdate(payload)
    case "twin_profile_get":
      return twinProfileGet(payload)
    case "host_capabilities":
      return hostCapabilities()
    case "host_feature_manifest":
      return hostFeatureManifest(payload)
    case "host_state_snapshot":
      return hostStateSnapshot(payload, bridge)
    case "host_state_submit":
      return hostStateSubmit(payload, bridge)
    case "host_state_status":
      return hostStateStatus(payload, bridge)
    case "provider_diagnostics_status": {
      const { getRemoteProviderDiagnosticsStatus } =
        await import("@/lib/provider-diagnostics/companion")
      return getRemoteProviderDiagnosticsStatus(payload)
    }
    case "provider_diagnostics_history": {
      const { getRemoteProviderDiagnosticsHistory } =
        await import("@/lib/provider-diagnostics/companion")
      return getRemoteProviderDiagnosticsHistory(payload)
    }
    case "provider_diagnostics_start": {
      const { startRemoteProviderDiagnostics } =
        await import("@/lib/provider-diagnostics/companion")
      return startRemoteProviderDiagnostics(payload)
    }
    case "provider_diagnostics_cancel": {
      const { cancelRemoteProviderDiagnostics } =
        await import("@/lib/provider-diagnostics/companion")
      return cancelRemoteProviderDiagnostics(payload)
    }
    // Mobile outbound-queue commands (Gap 3 reconciliation) — these go
    // through the same generic desktop_writes_bridge but land in
    // subsystem-specific dispatch arms below. Production callers:
    //   - connector_send         → app/share-target/page.tsx
    //   - connector_enqueue_outbound  → lib/connectors/inbox-writes/remote.ts
    //       (every Inbox reply from a phone / web companion / desktop that is
    //        driving this host — ADR-0131)
    //   - connector_approve_draft → components/mobile/connector/draft-approval-panel.tsx
    //       + lib/connectors/inbox-writes/remote.ts (carries edited segments)
    //   - connector_reject_draft  → components/mobile/connector/draft-approval-panel.tsx
    //       + lib/connectors/inbox-writes/remote.ts
    //   - workflow_trigger_manual → components/mobile/workflow/trigger-button.tsx
    //   - twin_ingest_source      → components/mobile/discover/twin-{sources,drafts}-panel.tsx
    case "connector_send":
      return connectorSend(payload)
    case "connector_enqueue_outbound":
      return connectorEnqueueOutbound(payload)
    case "connector_approve_draft":
      return connectorApproveDraft(payload)
    case "connector_reject_draft":
      return connectorRejectDraft(payload)
    case "workflow_placement_probe":
      return workflowPlacementProbe(payload)
    case "workflow_handoff_create":
      return workflowHandoffCreate(payload)
    case "workflow_trigger_manual":
      return workflowTriggerManual(payload)
    // Durable workflow approval gates (ADR-0061 P2). Host-split by design:
    // a Tauri host answers these natively from the Rust waitpoint mirror the
    // renderer writes through, so a paired device can decide while the WebView
    // is asleep. A headless brain has no such mirror — nothing there can call
    // the `workflow_waitpoint_create` Tauri command — so Rust diverts both
    // commands here, where this host's Dexie is the only authority. See the
    // guard in `src-tauri/src/companion_api/rpc/data_sync.rs`.
    case "workflow_approval_list":
      return workflowApprovalList()
    case "workflow_approval_respond":
      return workflowApprovalRespond(payload)
    case "workflow_human_input_list":
      return workflowHumanInputList(payload)
    case "workflow_human_input_submit":
      return workflowHumanInputSubmit(payload)
    case "workflow_step_result":
      return workflowStepResult(payload)
    case "device_capabilities_report":
      return deviceCapabilitiesReport(payload)
    case "twin_ingest_source":
      return twinIngestSource(payload)
    case "twin_draft_review":
      return twinDraftReview(payload)
    // Remote Session Control — attach / detach a remote watcher to a host
    // session so non-foreground `permission_request`s route to the phone
    // instead of being auto-denied. State lives in
    // `lib/companion/remote-attach-registry.ts`.
    case "session_attach":
      return sessionAttach(payload)
    case "session_detach":
      return sessionDetach(payload)
    // Remote Session Control — chunked attachment upload (ADR-0005 §4.5). The
    // bytes of a file staged on a phone reach the Host only through these five
    // arms; `message.enqueue` carries the ref they mint and nothing else.
    case "session_attachment_upload_init":
      return attachmentUploadInit(payload)
    case "session_attachment_upload_chunk":
      return attachmentUploadChunk(payload)
    case "session_attachment_upload_commit":
      return attachmentUploadCommit(payload)
    case "session_attachment_upload_abort":
      return attachmentUploadAbort(payload)
    // Remote Session Control — steer a host /goal self-driving loop. Routes
    // to the existing GoalRuntime transitions (which rotate generationId,
    // fire the turn-driver abort, append the audit event, and emit
    // `goal://status` for remote observers).
    case "goal_pause":
      return goalTransition(payload, "pause")
    case "goal_resume":
      return goalTransition(payload, "resume")
    case "goal_stop":
      return goalTransition(payload, "stop")
    // Agent-Team board control (team-board CQRS). Handlers revalidate every
    // move through the shared canMoveTask guard and answer { ok, reason? } —
    // see lib/companion/agent-team-write-handlers.ts.
    case "team_task_move":
      return handleTeamTaskMove(payload)
    case "team_task_create":
      return handleTeamTaskCreate(payload)
    case "team_task_comment":
      return handleTeamTaskComment(payload)
    case "team_run_pause":
      return handleTeamRunPause(payload)
    case "team_run_resume":
      return handleTeamRunResume(payload)
    case "team_run_stop":
      return handleTeamRunStop(payload)
    // Single-Agent task board control. Task ownership is revalidated against
    // the live Dexie row before every Scheduler or state-machine action.
    case "agent_task_start":
      return handleAgentTaskStart(payload)
    case "agent_task_pause":
      return handleAgentTaskPause(payload)
    case "agent_task_resume":
      return handleAgentTaskResume(payload)
    case "agent_task_cancel":
      return handleAgentTaskCancel(payload)
    case "agent_task_comment":
      return handleAgentTaskComment(payload)
    case "agent_task_move":
      return handleAgentTaskMove(payload)
    // Workflow CRUD (ADR-0027 Wave 4.1). Definitions live in Dexie; these
    // mirror the desktop editor's create/update/delete + schedule pause/resume
    // and a run listing + remote cancel.
    case "workflow_create":
      return workflowCreate(payload)
    case "workflow_update":
      return workflowUpdate(payload)
    case "workflow_delete":
      return workflowDelete(payload)
    case "workflow_run_list":
      return workflowRunList(payload)
    case "workflow_cancel_run":
      return workflowCancelRun(payload)
    case "workflow_schedule_pause":
      return workflowScheduleSet(payload, false)
    case "workflow_schedule_resume":
      return workflowScheduleSet(payload, true)
    // Twin source CRUD + job control (ADR-0003).
    case "twin_delete":
      return twinDelete(payload)
    case "twin_source_list":
      return twinSourceList(payload)
    case "twin_source_update":
      return twinSourceUpdate(payload)
    case "twin_source_delete":
      return twinSourceDelete(payload)
    case "twin_job_status":
      return twinJobStatus(payload)
    case "twin_job_cancel":
      return twinJobAction(payload, "cancel")
    case "twin_job_pause":
      return twinJobAction(payload, "pause")
    case "twin_job_resume":
      return twinJobAction(payload, "resume")
    case "twin_job_retry":
      return twinJobAction(payload, "retry")
    case "twin_create":
      return twinCreate(payload)
    case "twin_source_create":
      return twinSourceCreate(payload)
    case "twin_profile_update":
      return twinProfileUpdate(payload)
    // Goal create / update / status (coarse remote surface).
    case "goal_create":
      return goalCreate(payload)
    case "goal_update":
      return goalUpdate(payload)
    case "goal_status":
      return goalStatus(payload)
    // Long-term memory (ADR-0069). All five delegate to the shared
    // `lib/memory/api/*` helpers with `sourceChannel: "rpc"` — PII gate,
    // `external` provenance, never procedural. Writes are CONTROL-gated on
    // the Rust side; policy blocks come back as structured `{ ok: false }`.
    case "memory_search":
      return memorySearchRpc(payload)
    case "memory_list":
      return memoryListRpc(payload)
    case "memory_store":
      return memoryStoreRpc(payload)
    case "memory_update":
      return memoryUpdateRpc(payload)
    case "memory_forget":
      return memoryForgetRpc(payload)
    case "retrieval_profile_dek_export":
      return retrievalProfileDekExport(payload)
    // External agents (ADR-0056, Wave 4). The desktop's external-agent config
    // lives in the `cognia-external-agents` Zustand/localStorage store (NOT a
    // Dexie table, so no sync mirror) — these arms project + mutate it for the
    // phone's `/me/external-agents` page.
    //   - external_agent_list   → read-only projection (mirrors twin_profile_get)
    //   - external_agent_update → enable/disable + permission-mode edit
    case "external_agent_list":
      return externalAgentList()
    case "external_agent_update":
      return externalAgentUpdate(payload)
    // Settings — per-conversation overrides (pin/archive/title).
    case "conversation_overrides_update":
      return conversationOverridesUpdate(payload)
    // App-data backup.
    case "backup_export":
      return backupExport(payload)
    case "backup_import":
      return backupImport(payload)
    default:
      throw new Error(`unknown desktop-write command: ${command}`)
  }
}

async function resolveHostStateService(
  payload: Record<string, unknown>,
  bridge?: TauriBridge
): Promise<HostStateService> {
  const active = getActiveRuntimeTargetContext()
  const callerAccountId = payload.callerAccountId
  const authoritativeHostId = payload.authoritativeHostId
  const runtimeTargetId = payload.runtimeTargetId
  if (
    !active ||
    typeof callerAccountId !== "string" ||
    typeof authoritativeHostId !== "string" ||
    typeof runtimeTargetId !== "string" ||
    active.accountId !== callerAccountId ||
    active.targetId !== runtimeTargetId
  ) {
    throw new Error("host_state_scope_mismatch")
  }
  const key = `${active.accountId}:${active.targetId}:${authoritativeHostId}`
  if (hostStateAuthority?.key === key) return hostStateAuthority.service
  if (hostStateAuthority) await hostStateAuthority.service.stop()
  const service = createHostStateService({
    accountId: active.accountId,
    runtimeTargetId: active.targetId,
    hostId: authoritativeHostId,
    ownerId: hostStateOwnerId,
    dispatchRuntime: hostStateRuntimeDispatcher,
    publish: async (topic, event) => {
      const publish = bridge
        ? (name: string, args: Record<string, unknown>) => bridge.invoke(name, args)
        : (name: string, args: Record<string, unknown>) => invoke(name, args)
      const outcomes = await Promise.allSettled([
        publish("companion_host_state_publish", { topic, event }),
        publish("cli_bridge_host_state_publish", { event }),
      ])
      if (outcomes.every((outcome) => outcome.status === "rejected")) {
        throw new Error("host_state_event_publisher_unavailable")
      }
    },
  })
  await service.start()
  hostStateAuthority = { key, service }
  return service
}

async function hostStateSnapshot(
  payload: Record<string, unknown>,
  bridge?: TauriBridge
): Promise<unknown> {
  const service = await resolveHostStateService(payload, bridge)
  return service.snapshot(stripHostStateInternal(payload) as unknown as HostStateSnapshotRequest)
}

async function hostStateSubmit(
  payload: Record<string, unknown>,
  bridge?: TauriBridge
): Promise<unknown> {
  const service = await resolveHostStateService(payload, bridge)
  return service.submit(
    stripHostStateInternal(payload) as unknown as HostStateSubmitRequest,
    hostStateCaller(payload)
  )
}

/**
 * Lift the server-verified caller out of the RPC envelope.
 *
 * `rpc/host_state.rs::bind_authority` overwrites both fields from the
 * DPoP-verified JWT and the SecurityStore, so whatever the client sent is
 * already gone by the time the payload arrives here. A non-string device id or
 * a non-array grant list therefore means the request bypassed that binding, and
 * the service refuses the batch rather than treating it as an ungranted device.
 */
function hostStateCaller(payload: Record<string, unknown>): HostStateSubmitCaller {
  const deviceId = payload.callerDeviceId
  const grants = payload.callerDeviceGrants
  return {
    deviceId: typeof deviceId === "string" ? deviceId : "",
    // Malformed stays malformed. Coercing a non-array to `[]` here made
    // `assertCaller`'s array check unreachable, so a request that had skipped
    // `bind_authority` came back as ordinary per-action `host_state_forbidden`
    // receipts — exactly the routing bug that check exists to make loud. The
    // service refuses the batch instead.
    grants:
      Array.isArray(grants) && grants.every((entry) => typeof entry === "string")
        ? (grants as string[])
        : (grants as HostStateSubmitCaller["grants"]),
  }
}

async function hostStateStatus(
  payload: Record<string, unknown>,
  bridge?: TauriBridge
): Promise<unknown> {
  const service = await resolveHostStateService(payload, bridge)
  return service.status()
}

/**
 * Drop the server-injected authority fields so what reaches the service is the
 * closed protocol body the client actually constructed. `assertClosedSubmitRequest`
 * rejects any extra key, so this list must stay in lockstep with what
 * `rpc/host_state.rs::bind_authority` inserts.
 */
function stripHostStateInternal(payload: Record<string, unknown>): Record<string, unknown> {
  const {
    authoritativeHostId: _hostId,
    callerAccountId: _accountId,
    callerDeviceId: _deviceId,
    callerDeviceGrants: _grants,
    ...request
  } = payload
  return request
}

/**
 * The device behind an attach/detach, taken from the verified JWT.
 *
 * `rpc.rs::inject_caller_device_id` lists both commands, so `callerDeviceId` is
 * server-injected and overwrites whatever the client sent. The client's own
 * `deviceId` field is deliberately ignored: the attach registry decides which
 * device the Host routes a `permission_request` to, so honouring a self-asserted
 * id let any paired device collect another device's approval prompts.
 */
function callerDeviceIdFor(command: string, payload: Record<string, unknown>): string {
  const callerDeviceId = payload.callerDeviceId
  if (typeof callerDeviceId !== "string" || !callerDeviceId) {
    throw new Error(`${command}.callerDeviceId is required`)
  }
  return callerDeviceId
}

/**
 * Register a remote watcher and report what it actually got.
 *
 * Everything authoritative here is server-injected and any client-sent value is
 * overwritten before this arm runs: `callerDeviceId` (so a device cannot attach
 * under a borrowed id and collect another's prompts), `callerEventStreams` (so
 * it cannot claim to hear a run it has no stream for), and `callerDeviceGrants`
 * (so it cannot claim Remote Control it was never given). Only `mode` and
 * `attention` come from the caller, and both can only ever narrow what happens.
 */
function sessionAttach(payload: Record<string, unknown>): {
  mode: string
  downgradeReason: string | null
  eventPlane: string
  leaseTtlMs: number
  renewIntervalMs: number
  supportedActions: string[]
} {
  const sessionId = payload.sessionId as string | undefined
  if (!sessionId) throw new Error("session_attach.sessionId is required")
  const grants = readCallerGrants(payload.callerDeviceGrants)
  const result = attachSession(sessionId, callerDeviceIdFor("session_attach", payload), {
    requestedMode: readAttachMode(payload.mode),
    eventStreams: readEventStreams(payload.callerEventStreams),
    grants,
    attention: readAttention(payload.attention),
  })
  // The client needs the mode it actually got: asking for control and being
  // given observe is the difference between a composer and a read-only view.
  // The TTL travels with it so the renewal cadence is the Host's to change.
  //
  // `supportedActions` is the per-session capability answer: which HostState
  // intents this caller may actually submit here. Derived from the same table
  // `host_state_submit` authorizes against, so a client can never be shown an
  // action that would 403 — and an observer is told, rather than left to
  // discover it one rejected submit at a time. An observer gets none, whatever
  // it holds: the grants say what it MAY do, the attachment says whether it is
  // currently the one doing it.
  return {
    mode: result.mode,
    downgradeReason: result.downgradeReason,
    eventPlane: result.eventPlane,
    leaseTtlMs: ATTACH_LEASE_TTL_MS,
    renewIntervalMs: ATTACH_LEASE_RENEW_INTERVAL_MS,
    supportedActions: result.mode === "control" ? permittedHostStateIntentKinds(grants) : [],
  }
}

/** Absent means `control` — see `AttachSessionOptions.requestedMode`. */
function readAttachMode(raw: unknown): AttachMode {
  return raw === "observe" ? "observe" : "control"
}

/**
 * Server-injected event-plane leases. A malformed or absent value reads as "no
 * streams", which downgrades the attachment to observe rather than letting a
 * bad payload confer control.
 */
function readEventStreams(raw: unknown): EventStreamConnection[] {
  if (!Array.isArray(raw)) return []
  const streams: EventStreamConnection[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const { leaseId, transport, state, openedAt } = entry as Record<string, unknown>
    if (typeof leaseId !== "string" || !leaseId) continue
    if (transport !== "ws" && transport !== "rtc") continue
    if (state !== "connecting" && state !== "replaying" && state !== "ready") continue
    streams.push({
      leaseId,
      transport,
      state,
      openedAt: typeof openedAt === "number" ? openedAt : 0,
    })
  }
  return streams
}

/** Server-injected capability grants; anything else reads as "no grants". */
function readCallerGrants(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((grant): grant is string => typeof grant === "string" && grant.length > 0)
}

/**
 * Client-reported foreground/background. Unrecognized or absent reads as
 * `unknown`, which suppresses no notification — the fail-safe direction, since
 * the cost of a wrong `foreground` is a decision prompt nobody is shown.
 */
function readAttention(raw: unknown): "foreground" | "background" | "unknown" {
  return raw === "foreground" || raw === "background" ? raw : "unknown"
}

function sessionDetach(payload: Record<string, unknown>): null {
  const sessionId = payload.sessionId as string | undefined
  if (!sessionId) throw new Error("session_detach.sessionId is required")
  detachSession(sessionId, callerDeviceIdFor("session_detach", payload))
  return null
}

/**
 * Open (or rejoin) an attachment upload.
 *
 * The session and the device are the two things a client must not be able to
 * choose: `callerDeviceId` is server-injected, and the session it names is
 * written into the row so a later chunk cannot re-point the file at a
 * conversation the device was never attached to. Everything else — the name,
 * the declared type, the size, the hash — is a claim, and every one of them is
 * checked again at commit against the bytes that actually arrived.
 *
 * Answers `resumeOffset` rather than assuming zero, so a client that lost its
 * socket (or its process) mid-file continues from the write head instead of
 * paying for the whole transfer twice.
 */
async function attachmentUploadInit(payload: Record<string, unknown>): Promise<{
  uploadId: string
  chunkSize: number
  resumeOffset: number
  complete: boolean
  ref: string | null
}> {
  const command = "session_attachment_upload_init"
  const result = await beginAttachmentUpload({
    sessionId: requiredString(command, payload, "sessionId"),
    deviceId: callerDeviceIdFor(command, payload),
    name: requiredString(command, payload, "name"),
    mediaType: requiredString(command, payload, "mediaType"),
    size: requiredNumber(command, payload, "size"),
    hash: requiredString(command, payload, "hash"),
  })
  return {
    uploadId: result.uploadId,
    chunkSize: result.chunkSize,
    resumeOffset: result.resumeOffset,
    complete: result.complete,
    ref: result.ref ?? null,
  }
}

/** Append one chunk. `receivedBytes` comes back so a client that guessed the
 *  offset wrong can re-sync without restarting the file. */
async function attachmentUploadChunk(
  payload: Record<string, unknown>
): Promise<{ receivedBytes: number; complete: boolean }> {
  const command = "session_attachment_upload_chunk"
  return appendAttachmentChunk({
    uploadId: requiredString(command, payload, "uploadId"),
    deviceId: callerDeviceIdFor(command, payload),
    offset: requiredNumber(command, payload, "offset"),
    bytes: decodeChunk(command, payload.dataBase64),
  })
}

/** Seal the upload and mint its ref. */
async function attachmentUploadCommit(payload: Record<string, unknown>): Promise<{
  ref: string
  name: string
  mediaType: string
  size: number
  hash: string
}> {
  const command = "session_attachment_upload_commit"
  return commitAttachmentUpload({
    uploadId: requiredString(command, payload, "uploadId"),
    deviceId: callerDeviceIdFor(command, payload),
  })
}

/** Discard an upload the client gave up on, freeing its staging slot. */
async function attachmentUploadAbort(payload: Record<string, unknown>): Promise<null> {
  const command = "session_attachment_upload_abort"
  await abortAttachmentUpload({
    uploadId: requiredString(command, payload, "uploadId"),
    deviceId: callerDeviceIdFor(command, payload),
  })
  return null
}

function requiredString(command: string, payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${command}.${field} is required`)
  }
  return value
}

function requiredNumber(command: string, payload: Record<string, unknown>, field: string): number {
  const value = payload[field]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${command}.${field} is required`)
  }
  return value
}

/**
 * Decode one base64 chunk.
 *
 * Rejects rather than truncates on malformed input: a chunk that silently
 * decoded to fewer bytes than the client sent would sail past the offset check
 * and only surface as a hash mismatch at the end of a 10 MB transfer.
 */
function decodeChunk(command: string, raw: unknown): Uint8Array {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${command}.dataBase64 is required`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    throw new Error(`${command}.dataBase64 is not valid base64`)
  }
  const binary =
    typeof atob === "function" ? atob(raw) : Buffer.from(raw, "base64").toString("binary")
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function goalTransition(
  payload: Record<string, unknown>,
  action: "pause" | "resume" | "stop"
): Promise<{ goal: unknown }> {
  const goalId = payload.goalId as string | undefined
  if (!goalId) throw new Error(`goal_${action}.goalId is required`)
  const runtime = getGoalRuntime()
  const goal =
    action === "pause"
      ? await runtime.pauseGoal(goalId)
      : action === "resume"
        ? await runtime.resumeGoal(goalId)
        : await runtime.stopGoal(goalId)
  return { goal }
}

/** Read string[] nameHints from the payload, tolerating an absent field. */
function readNameHints(payload: Record<string, unknown>): string[] {
  const raw = payload.nameHints
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
    throw new Error("nameHints must be an array of strings")
  }
  return raw as string[]
}

/**
 * Start a new self-driving goal for a session. Delegates to the canonical
 * `GoalRuntime.createGoal`, so every guardrail the desktop /goal command runs
 * (PII redaction of the objective, the IM opt-in gate, /loop exclusivity,
 * superseding an existing open goal) applies identically to the remote path.
 * App settings are loaded locally to feed the redaction allowlist.
 */
async function goalCreate(payload: Record<string, unknown>): Promise<{ goal: unknown }> {
  const sessionId = payload.sessionId as string | undefined
  const rawObjective = payload.rawObjective as string | undefined
  if (!sessionId) throw new Error("goal_create.sessionId is required")
  if (typeof rawObjective !== "string" || rawObjective.trim().length === 0) {
    throw new Error("goal_create.rawObjective is required")
  }
  const appSettings = await getSettings().catch(() => null)
  const goal = await getGoalRuntime().createGoal({
    sessionId,
    rawObjective,
    characterId: payload.characterId as string | undefined,
    config: payload.config as Partial<GoalConfig> | undefined,
    nameHints: readNameHints(payload),
    startPaused: payload.startPaused === true,
    appSettings,
    // A paired device drives this — the operator is not at the desktop's
    // Continue button, so treat it as headless for manual-continue (ADR-0070
    // Phase 2). The acceptance gate still applies and resolves from either end.
    origin: "remote",
  })
  return { goal }
}

/**
 * Re-aim or reconfigure an open goal. `rawObjective` re-runs the redaction +
 * objective-update flow (returning the model-facing update prompt); `config`
 * patches the goal config. At least one must be present.
 */
async function goalUpdate(
  payload: Record<string, unknown>
): Promise<{ goal: unknown; updatePrompt?: string }> {
  const goalId = payload.goalId as string | undefined
  if (!goalId) throw new Error("goal_update.goalId is required")
  const rawObjective = payload.rawObjective as string | undefined
  const config = payload.config as Partial<GoalConfig> | undefined
  if (rawObjective === undefined && config === undefined) {
    throw new Error("goal_update requires rawObjective and/or config")
  }

  let goal: unknown = null
  let updatePrompt: string | undefined
  if (rawObjective !== undefined) {
    if (typeof rawObjective !== "string" || rawObjective.trim().length === 0) {
      throw new Error("goal_update.rawObjective must be a non-empty string")
    }
    const result = await getGoalRuntime().updateObjective(
      goalId,
      rawObjective,
      readNameHints(payload)
    )
    // `null` means the goal is missing/terminal or the objective is unchanged.
    if (result) {
      goal = result.goal
      updatePrompt = result.updatePrompt
    }
  }
  if (config !== undefined) {
    if (!config || typeof config !== "object") {
      throw new Error("goal_update.config must be an object")
    }
    goal = await getGoalRuntime().updateConfig(goalId, config)
  }
  // Fall back to the current persisted state when nothing changed, so the
  // caller always gets the goal it referenced rather than a bare null.
  if (goal === null) {
    goal = (await getGoal(goalId)) ?? null
  }
  return { goal, updatePrompt }
}

/**
 * Read goal status. With `goalId`, returns that goal; with `sessionId`,
 * returns the session's active goal plus the full goal list. Pure read.
 */
async function goalStatus(
  payload: Record<string, unknown>
): Promise<{ goal?: unknown; activeGoal?: unknown; goals?: unknown[] }> {
  const goalId = payload.goalId as string | undefined
  if (goalId) {
    const goal = await getGoal(goalId)
    return { goal: goal ?? null }
  }
  const sessionId = payload.sessionId as string | undefined
  if (!sessionId) {
    throw new Error("goal_status requires goalId or sessionId")
  }
  const [activeGoal, goals] = await Promise.all([
    getActiveGoalForSession(sessionId),
    listGoalsBySession(sessionId),
  ])
  return { activeGoal: activeGoal ?? null, goals }
}

// ── Long-term memory (ADR-0069) ─────────────────────────────────────────────

async function memorySearchRpc(payload: Record<string, unknown>): Promise<unknown> {
  const query = payload.query as string | undefined
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("memory_search.query is required")
  }
  const { searchMemoriesExternal } = await import("@/lib/memory/api/search-memory")
  const result = await searchMemoriesExternal({
    query,
    topK: typeof payload.k === "number" ? payload.k : undefined,
    types: payload.types as never,
    characterId: payload.characterId as string | undefined,
    projectId: payload.projectId as string | undefined,
    agentId: payload.agentId as string | undefined,
    branch: payload.branch as string | undefined,
    path: payload.path as string | undefined,
  })
  if (!result.ok) return result
  const { toMemoryWireRow } = await import("@/lib/memory/api/wire")
  return {
    ok: true,
    hits: result.hits.map((h) => ({
      memory: toMemoryWireRow(h.memory),
      relevance: h.relevance,
      score: h.score,
    })),
  }
}

async function memoryListRpc(payload: Record<string, unknown>): Promise<unknown> {
  const [{ getSettings: loadSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await loadSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { ok: false, reason: "disabled" }
  if (config.temporary) return { ok: false, reason: "temporary" }
  const [{ listMemories }, { toMemoryWireRow }] = await Promise.all([
    import("@/lib/db/memories"),
    import("@/lib/memory/api/wire"),
  ])
  const rows = await listMemories({
    type: payload.type as never,
    scope: payload.scope as never,
    characterId: payload.characterId as string | undefined,
    projectId: payload.projectId as string | undefined,
    agentId: payload.agentId as string | undefined,
    branch: payload.branch as string | undefined,
    pathPattern: payload.pathPattern as string | undefined,
    status: "active",
  })
  const limit = Math.min(200, Math.max(1, typeof payload.limit === "number" ? payload.limit : 50))
  return { ok: true, memories: rows.slice(0, limit).map(toMemoryWireRow) }
}

async function memoryStoreRpc(payload: Record<string, unknown>): Promise<unknown> {
  const text = payload.text as string | undefined
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("memory_store.text is required")
  }
  const { storeExternalMemory } = await import("@/lib/memory/api/store-memory")
  return storeExternalMemory(
    {
      text,
      type: payload.type as never,
      scope: payload.scope as never,
      characterId: payload.characterId as string | undefined,
      projectId: payload.projectId as string | undefined,
      agentId: payload.agentId as string | undefined,
      branch: payload.branch as string | undefined,
      pathPattern: payload.pathPattern as string | undefined,
      key: payload.key as string | undefined,
      importance: typeof payload.importance === "number" ? payload.importance : undefined,
      tags: payload.tags as string[] | undefined,
    },
    { channel: "rpc" }
  )
}

async function memoryUpdateRpc(payload: Record<string, unknown>): Promise<unknown> {
  const id = payload.id as string | undefined
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("memory_update.id is required")
  }
  const { updateExternalMemory } = await import("@/lib/memory/api/mutate-memory")
  return updateExternalMemory(id, {
    text: payload.text as string | undefined,
    importance: typeof payload.importance === "number" ? payload.importance : undefined,
    tags: payload.tags as string[] | undefined,
    key: payload.key as string | undefined,
    pinned: typeof payload.pinned === "boolean" ? payload.pinned : undefined,
  })
}

async function memoryForgetRpc(payload: Record<string, unknown>): Promise<unknown> {
  const id = payload.id as string | undefined
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("memory_forget.id is required")
  }
  const { forgetExternalMemory } = await import("@/lib/memory/api/mutate-memory")
  return forgetExternalMemory(id)
}

async function characterUpsert(payload: Record<string, unknown>): Promise<{ character: unknown }> {
  const id = payload.id as string | undefined
  const draft = payload.draft as CharacterDraft
  if (!draft || typeof draft !== "object") {
    throw new Error("character_upsert.draft is required")
  }
  if (id) {
    const updated = await updateCharacter(id, draft)
    return { character: updated }
  }
  const created = await createCharacter(draft)
  return { character: created }
}

async function characterDelete(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  if (!id) throw new Error("character_delete.id is required")
  await deleteCharacter(id)
  return null
}

async function characterBindTwin(payload: Record<string, unknown>): Promise<null> {
  const characterId = payload.characterId as string | undefined
  const twinIdRaw = payload.twinId
  if (!characterId) throw new Error("character_bind_twin.characterId is required")
  const twinId = twinIdRaw === null || twinIdRaw === undefined ? undefined : String(twinIdRaw)
  await updateCharacter(characterId, { twinId })
  return null
}

async function skillSetEnabled(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  const enabled = payload.enabled as boolean | undefined
  if (!id) throw new Error("skill_set_enabled.id is required")
  if (typeof enabled !== "boolean") throw new Error("skill_set_enabled.enabled must be boolean")
  // Skill carries `status: "enabled" | "disabled"` (see `lib/claude/types.ts`),
  // not a boolean field — the Wave 2 RPC accepts a boolean for ergonomics
  // and translates here.
  await getDb().skills.update(id, {
    status: enabled ? "enabled" : "disabled",
    updatedAt: Date.now(),
  })
  return null
}

/** A plugin enable/disable failure that is NOT a genuine runtime error
 *  (dependency / activation failure) but rather "there is no live manager to
 *  drive here" — an uninitialized PluginManager (headless cognia-server, or a
 *  test context) or a plugin the running store has never discovered. In those
 *  cases we safely fall back to persisting the flag. Genuine enable failures
 *  must surface to the caller, not be masked by a silent flag flip. */
function isPluginManagerUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /initialized PluginManager|Plugin not found/i.test(message)
}

async function pluginSetEnabled(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  const enabled = payload.enabled as boolean | undefined
  if (!id) throw new Error("plugin_set_enabled.id is required")
  if (typeof enabled !== "boolean") throw new Error("plugin_set_enabled.enabled must be boolean")

  // Mirror the desktop toggle: drive the live PluginManager through the plugin
  // runtime store so the plugin actually loads/unloads, its required
  // dependencies are resolved, contributions register/unregister, and the
  // enabled flag is persisted to Dexie + the Rust backend by the manager's
  // `syncBackendStatus`. A bare Dexie flag write (the previous behavior) only
  // took effect on the next renderer reload and skipped dependency resolution.
  try {
    const { usePluginStore } = await import("@/stores/plugin-runtime/plugin-store")
    const store = usePluginStore.getState()
    if (enabled) {
      await store.enablePlugin(id)
    } else {
      await store.disablePlugin(id)
    }
    return null
  } catch (error) {
    // No live manager (headless / uninitialized) or unknown-to-store plugin:
    // persist the flag so it applies on the next load. Re-throw genuine enable
    // failures (dependency / activation errors) so the remote caller sees them.
    if (isPluginManagerUnavailable(error)) {
      await getDb().plugins.update(id, { enabled, updatedAt: Date.now() })
      return null
    }
    throw error
  }
}

/**
 * Flip one MCP server's `enabled` flag from a paired client.
 *
 * Routed through `updateMcpServer` rather than a bare Dexie write so the
 * governance side effects a desktop toggle has still run: the trust gate, the
 * summary mirror the caller reads back, and the coalesced sync into every
 * agent config file this server is projected into.
 */
async function mcpSetEnabled(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  const enabled = payload.enabled as boolean | undefined
  if (!id) throw new Error("mcp_set_enabled.id is required")
  if (typeof enabled !== "boolean") throw new Error("mcp_set_enabled.enabled must be boolean")
  const { updateMcpServer } = await import("@/lib/db/mcp-servers")
  await updateMcpServer(id, { enabled })
  return null
}

/**
 * Replace one MCP server's per-tool deny rules from a paired client.
 *
 * Both axes are sent whole rather than as add/remove deltas: the client
 * renders the full list it read from `mcpServerSummaries`, and a delta applied
 * against a stale mirror would silently re-allow a tool the user had denied on
 * another device.
 */
async function mcpSetToolRules(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  if (!id) throw new Error("mcp_set_tool_rules.id is required")
  const toStringList = (value: unknown, field: string): string[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error(`mcp_set_tool_rules.${field} must be a string array`)
    }
    return value as string[]
  }
  const disallowedTools = toStringList(payload.disallowedTools, "disallowedTools")
  const disallowedToolPatterns = toStringList(
    payload.disallowedToolPatterns,
    "disallowedToolPatterns"
  )
  if (disallowedTools === undefined && disallowedToolPatterns === undefined) {
    throw new Error("mcp_set_tool_rules requires disallowedTools or disallowedToolPatterns")
  }
  const { updateMcpServer } = await import("@/lib/db/mcp-servers")
  await updateMcpServer(id, {
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(disallowedToolPatterns !== undefined ? { disallowedToolPatterns } : {}),
  })
  return null
}

/**
 * Apply one bot's policy relayed from a paired client.
 *
 * `parseAdapterPolicyRelay` owns the wire vocabulary and the absent-vs-null
 * distinction; this arm owns only the writing. Each section lands through
 * `updateAdapterConfigSection`, so a change made from a phone leaves the same
 * `adapter.config_changed` breadcrumb as the desktop card that owns those
 * fields — attributed to `"mobile"`, the source this queue has always been
 * spelled with (it covers every paired client, phone or not).
 *
 * Sections are applied in order and each is its own transaction. A malformed
 * field throws before any of them run, so a rejected request never leaves half
 * a policy behind; a failure *between* sections is reported to the caller with
 * the earlier sections already committed, which is the same granularity the
 * desktop cards have — they are separate saves there too.
 */
async function adapterUpdatePolicy(payload: Record<string, unknown>): Promise<null> {
  const { id, sections } = parseAdapterPolicyRelay(payload)
  for (const { section, patch } of sections) {
    await updateAdapterConfigSection(id, section, patch, "mobile")
  }
  return null
}

async function appSettingsUpdate(
  payload: Record<string, unknown>
): Promise<{ settings: AppSettings }> {
  const patch = payload.patch as Partial<AppSettings> | undefined
  if (!patch || typeof patch !== "object") {
    throw new Error("app_settings_update.patch is required")
  }
  const settings = await saveSettings(patch)
  return { settings }
}

async function twinProfileGet(payload: Record<string, unknown>): Promise<unknown> {
  const twinId = payload.twinId as string | undefined
  if (!twinId) throw new Error("twin_profile_get.twinId is required")
  const profile = await getDb().twinProfile.get(twinId)
  return { profile: profile ?? null }
}

/**
 * What this host can do, from the host's own point of view.
 *
 * A client driving a remote host had no way to ask this. `remoteCapabilityUnion`
 * aggregates devices that paired *into* this machine, so it structurally cannot
 * see the host you are driving — which meant workflow preflight judged a remote
 * cloud server by the desktop's own baseline and rejected `always-on` /
 * `headless` work the server could have run.
 *
 * Answered here rather than in Rust deliberately: the capability vocabulary
 * lives in `lib/platform/capabilities.ts`, and this handler is installed by both
 * the desktop renderer and the headless brain, so one implementation serves both
 * kinds of host and there is no second list to drift.
 */
async function hostCapabilities(): Promise<unknown> {
  const [{ detectLocalCapabilities }, { detectPlatform }] = await Promise.all([
    import("@/lib/platform/capabilities"),
    import("@/lib/platform/detect"),
  ])
  return { platform: detectPlatform(), capabilities: detectLocalCapabilities() }
}

async function hostFeatureManifest(payload: Record<string, unknown>): Promise<unknown> {
  const [{ buildLocalHostFeatureManifest }, { detectPlatform }] = await Promise.all([
    import("@/lib/platform/host-feature-manifest"),
    import("@/lib/platform/detect"),
  ])
  const callerDeviceGrants = payload.callerDeviceGrants
  const deviceGrants =
    Array.isArray(callerDeviceGrants) &&
    callerDeviceGrants.every((grant) => typeof grant === "string" && grant.length > 0)
      ? callerDeviceGrants
      : undefined
  const platform = detectPlatform()
  const operationHealth: Record<string, boolean | { healthy: boolean; reason?: string }> = {}
  const ocrOperations = [
    "ocr_list_native_backends",
    "ocr_list_available_backends",
    "ocr_extract_native",
    "ocr_model_status",
    "ocr_download_model",
    "ocr_cancel_model_download",
  ]
  if (platform === "tauri" || platform === "headless") {
    try {
      const available =
        platform === "headless"
          ? await (
              await import("@/lib/tauri")
            ).transport.call<string[]>("ocr_list_available_backends")
          : await (
              await import("@tauri-apps/api/core")
            ).invoke<string[]>("ocr_list_available_backends")
      for (const operation of ocrOperations) operationHealth[operation] = true
      if (available.length === 0) {
        operationHealth.ocr_extract_native = {
          healthy: false,
          reason: "no native OCR backend is callable in this host build",
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      for (const operation of ocrOperations) {
        operationHealth[operation] = { healthy: false, reason }
      }
    }
  }
  if (platform === "headless") {
    const browserOperations = [
      "browser_capability",
      "browser_session_ensure",
      "browser_session_get",
      "browser_session_close",
      "browser_navigate",
      "browser_snapshot",
      "browser_act",
      "browser_press_key",
      "browser_scroll",
      "browser_evaluate",
      "browser_read_console",
      "browser_read_network",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_stop",
      "browser_get_page",
      "browser_pages",
      "browser_switch_page",
      "browser_close_page",
      "browser_wait_for",
      "browser_wait_for_load",
      "browser_screenshot",
      "browser_set_files",
      "browser_downloads",
      "browser_set_zoom",
      "browser_find",
      "browser_find_clear",
    ]
    try {
      const status = await (
        await import("@/lib/tauri")
      ).transport.call<{
        healthy?: boolean
        reason?: string
      }>("browser_runtime_status", {
        ...(typeof payload.workspaceId === "string" ? { workspaceId: payload.workspaceId } : {}),
      })
      operationHealth.browser_runtime_status = true
      for (const operation of browserOperations) {
        operationHealth[operation] = status.healthy
          ? true
          : { healthy: false, reason: status.reason ?? "browser runtime probe failed" }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      operationHealth.browser_runtime_status = { healthy: false, reason }
      for (const operation of browserOperations) {
        operationHealth[operation] = { healthy: false, reason }
      }
    }
  }
  return buildLocalHostFeatureManifest({
    platform,
    hostId:
      typeof payload.authoritativeHostId === "string"
        ? payload.authoritativeHostId
        : `local-${platform}`,
    deviceGrants,
    operationHealth,
  })
}

// ---------------------------------------------------------------------------
// Mobile outbound-queue handlers (Gap 3 reconciliation)
// ---------------------------------------------------------------------------

/**
 * ADR-0131 §2.7 — refuse a relayed Inbox write when THIS process does not own
 * the connector runtime. During a desktop ⇄ headless-brain handoff the bridge
 * can route a phone's reply to the side that just released the lease; running
 * it there would enqueue an outbound job no runner picks up (or, worse, a
 * second one once the owner also handles the retry).
 *
 * The thrown message is deliberately free of the words `lib/queue/retry-policy.ts`
 * treats as terminal (`not found`, `bad request`, `validation`, `401/403/404`,
 * …), so the phone's durable queue RETRIES: 5 attempts of exponential backoff
 * ≈ 31 s, which covers a normal lease handoff. `install-connector-runtime.ts`
 * pins the classification in its tests.
 */
function requireConnectorRuntimeOwnership(command: string): void {
  if (isConnectorRuntimeOwnedHere()) return
  throw new Error(
    `connector_runtime_not_owner: ${command} reached a process that does not own the connector runtime; retry`
  )
}

type ConnectorSegment = { type?: string; text?: string }

/** Insert a user-authored message into the named session. Production caller
 *  is the share-target page, which receives a piece of shared text/url from
 *  the OS and routes it to a selected chat session.
 *
 *  NOTE: the `connector_send` name is historical (it shares the mobile
 *  outbound-queue command set) — this does NOT transmit to any external
 *  connector platform and does NOT trigger an AI reply. It only appends a
 *  local `role: "user"` message row. Real connector outbound goes through
 *  `connector_approve_draft` → the desktop outbound runner; an AI turn goes
 *  through `claude_send`. */
async function connectorSend(payload: Record<string, unknown>): Promise<{ messageId: string }> {
  const sessionId = payload.sessionId as string | undefined
  const segmentsRaw = payload.segments as unknown
  if (!sessionId) throw new Error("connector_send.sessionId is required")
  if (!Array.isArray(segmentsRaw)) {
    throw new Error("connector_send.segments must be an array")
  }
  const text = (segmentsRaw as ConnectorSegment[])
    .map((s) => (typeof s.text === "string" ? s.text : ""))
    .filter((s) => s.length > 0)
    .join("\n")
  if (text.length === 0) {
    throw new Error("connector_send.segments yielded no text content")
  }
  const id = "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
  const row: StoredMessage = {
    id,
    sessionId,
    role: "user",
    parts: [{ type: "text", text }],
    createdAt: Date.now(),
  }
  await getDb().messages.add(row)
  markSessionDirty(sessionId)
  return { messageId: id }
}

/**
 * ADR-0131 cross-shell inbox relay — the real "send this reply to the
 * platform" arm. Runs the SAME `sendManualReplyLocally` the desktop composer
 * runs (`lib/connectors/inbox-writes/local.ts`), so a phone reply and a
 * desktop reply produce byte-identical `outboundQueue` + `messages` rows.
 *
 * Idempotent by construction: the client mints `request.metadata.idempotencyKey`
 * ONCE and replays it on every retry, and `sendManualReplyLocally` returns the
 * existing job instead of enqueuing a second one. The durable queue therefore
 * cannot double-send across a dropped connection.
 */
async function connectorEnqueueOutbound(
  payload: Record<string, unknown>
): Promise<{ jobId: string; messageId: string; reused: boolean }> {
  requireConnectorRuntimeOwnership("connector_enqueue_outbound")
  const adapterId = payload.adapterId as string | undefined
  const conversationKey = payload.conversationKey as string | undefined
  const sessionId = payload.sessionId as string | undefined
  const request = payload.request as OutboundRequest | undefined
  if (!adapterId) throw new Error("connector_enqueue_outbound.adapterId is required")
  if (!conversationKey) throw new Error("connector_enqueue_outbound.conversationKey is required")
  if (!sessionId) throw new Error("connector_enqueue_outbound.sessionId is required")
  if (!request || typeof request !== "object") {
    throw new Error("connector_enqueue_outbound.request is required")
  }
  if (!Array.isArray(request.segments)) {
    throw new Error("connector_enqueue_outbound.request.segments must be an array")
  }
  const idempotencyKey = request.metadata?.idempotencyKey
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new Error("connector_enqueue_outbound.request.metadata.idempotencyKey is required")
  }
  const { sendManualReplyLocally } = await import("@/lib/connectors/inbox-writes/local")
  return sendManualReplyLocally({
    adapterId,
    conversationKey,
    sessionId,
    conversationRef: request.conversationRef,
    segments: request.segments,
    idempotencyKey,
    clientMessageId: payload.clientMessageId as string | undefined,
    replyTo: request.replyTo,
    threadId: request.threadId,
  })
}

/** Approve a pending connector draft so the connector outbound runner can
 *  pick it up for the real platform send. `segments` (ADR-0131) carries what
 *  the operator actually approved after editing it on the phone; without it
 *  the draft's own segments are sent. */
async function connectorApproveDraft(
  payload: Record<string, unknown>
): Promise<{ draftId: string; jobId?: string; alreadyApproved: boolean }> {
  requireConnectorRuntimeOwnership("connector_approve_draft")
  const draftId = payload.draftId as string | undefined
  if (!draftId) throw new Error("connector_approve_draft.draftId is required")
  const segments = payload.segments as MessageSegment[] | undefined
  if (segments !== undefined && !Array.isArray(segments)) {
    throw new Error("connector_approve_draft.segments must be an array when present")
  }
  const { approveDraftLocally } = await import("@/lib/connectors/inbox-writes/local")
  return approveDraftLocally(draftId, { segments })
}

/** Reject a pending connector draft. */
async function connectorRejectDraft(payload: Record<string, unknown>): Promise<null> {
  requireConnectorRuntimeOwnership("connector_reject_draft")
  const draftId = payload.draftId as string | undefined
  if (!draftId) throw new Error("connector_reject_draft.draftId is required")
  const { rejectDraftLocally } = await import("@/lib/connectors/inbox-writes/local")
  await rejectDraftLocally(draftId)
  return null
}

/** Trigger a workflow run manually from the mobile shell. Routes through the
 *  same orchestrator path the desktop UI / cron daemon use. The trigger
 *  `kind` matches the canonical workflow-node identifier `"trigger.manual"`
 *  declared in `types/workflow/visual.ts:WorkflowNodeKind`. */
async function workflowTriggerManual(payload: Record<string, unknown>): Promise<null> {
  const workflowId = payload.workflowId as string | undefined
  if (!workflowId) throw new Error("workflow_trigger_manual.workflowId is required")
  // `callerDeviceId` is injected by the Rust RPC layer from the verified
  // verified DPoP device context (ADR-0060) — never trusted from the raw client payload.
  const deviceId = payload.callerDeviceId as string | undefined
  await dispatchTrigger(
    {
      workflowId,
      kind: "trigger.manual",
      payload: payload.input ?? null,
      originAt: Date.now(),
    },
    { triggeredBy: { source: "api", ...(deviceId ? { deviceId } : {}) } }
  )
  return null
}

async function workflowPlacementProbe(payload: Record<string, unknown>): Promise<unknown> {
  const deploymentId = payload.deploymentId as string | undefined
  const expectedVersionDigest = payload.expectedVersionDigest as string | undefined
  if (!deploymentId) throw new Error("workflow_placement_probe.deploymentId is required")
  if (!expectedVersionDigest) {
    throw new Error("workflow_placement_probe.expectedVersionDigest is required")
  }
  const { probeWorkflowPlacement } = await import("@/lib/workflow/api/workflow-api-service")
  return probeWorkflowPlacement({
    accountId: getActiveAccountId(),
    deploymentId,
    expectedVersionDigest,
    scopes: ["workflow:read"],
  })
}

async function workflowHandoffCreate(payload: Record<string, unknown>): Promise<unknown> {
  const deploymentId = payload.deploymentId as string | undefined
  const expectedVersionDigest = payload.expectedVersionDigest as string | undefined
  const idempotencyKey = payload.idempotencyKey as string | undefined
  const callerDeviceId = payload.callerDeviceId as string | undefined
  if (!deploymentId) throw new Error("workflow_handoff_create.deploymentId is required")
  if (!expectedVersionDigest) {
    throw new Error("workflow_handoff_create.expectedVersionDigest is required")
  }
  if (!idempotencyKey) throw new Error("workflow_handoff_create.idempotencyKey is required")
  if (!callerDeviceId) throw new Error("workflow_handoff_create caller identity is required")
  if (!isTriggerEvent(payload.trigger)) {
    throw new Error("workflow_handoff_create.trigger is invalid")
  }
  const { createWorkflowApiRun } = await import("@/lib/workflow/api/workflow-api-service")
  return createWorkflowApiRun({
    accountId: getActiveAccountId(),
    deploymentId,
    expectedVersionDigest,
    entrypoint: "trigger",
    caller: `host:${callerDeviceId}`,
    scopes: ["workflow:run", "workflow:read"],
    idempotencyKey,
    trigger: payload.trigger,
    triggeredBy: { source: "api", deviceId: callerDeviceId },
    input: payload.trigger.payload,
  })
}

/** Read-only projection of the pending workflow-approval registry (ADR-0061). */
/** List pending approval + risk_gate waitpoints, oldest first. Reached only on
 *  a headless host (a Tauri host answers natively) — see the dispatch arm. The
 *  returned rows must keep satisfying the closed `workflow_approval_list`
 *  output contract in `crates/cognia-cli/assets/host-command-catalog.json`. */
async function workflowApprovalList(): Promise<{ approvals: unknown[] }> {
  const { listPendingApprovals } = await import("@/lib/workflow/runtime/approval-registry")
  return { approvals: await listPendingApprovals() }
}

/** Resolve a pending `action.approval.request` gate from a paired device.
 *  Control-gated in Rust; the responder identity is the JWT-verified
 *  `callerDeviceId` injected by the RPC layer (spoof-proof). Reached only on a
 *  headless host — see the dispatch arm. */
async function workflowApprovalRespond(
  payload: Record<string, unknown>
): Promise<{ ok: boolean; reason?: string }> {
  const approvalIdArg = payload.approvalId as string | undefined
  if (!approvalIdArg) throw new Error("workflow_approval_respond.approvalId is required")
  const decision = payload.decision
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error("workflow_approval_respond.decision must be 'approved' or 'rejected'")
  }
  const deviceId = payload.callerDeviceId as string | undefined
  const { respondToApproval } = await import("@/lib/workflow/runtime/approval-registry")
  const result = await respondToApproval(approvalIdArg, {
    decision,
    respondedBy: deviceId ? `device:${deviceId}` : "companion",
  })
  return result.ok ? { ok: true } : { ok: false, reason: result.reason }
}

function companionHumanInputActor(
  callerDeviceId: string,
  initiatorId?: string
): { id: string; isInitiator?: boolean } {
  const id = `device:${callerDeviceId}`
  return { id, ...(initiatorId === id ? { isInitiator: true } : {}) }
}

const HUMAN_INPUT_FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

function humanInputFileMatchesAccept(
  accept: readonly string[] | undefined,
  file: { name: string; mediaType: string }
): boolean {
  if (!accept || accept.length === 0) return true
  const lowerName = file.name.toLowerCase()
  const lowerMediaType = file.mediaType.toLowerCase()
  return accept.some((raw) => {
    const token = raw.trim().toLowerCase()
    if (token.startsWith(".")) return lowerName.endsWith(token)
    if (token.endsWith("/*")) return lowerMediaType.startsWith(token.slice(0, -1))
    return lowerMediaType === token
  })
}

async function promoteCompanionHumanInputFiles(input: {
  request: import("@/types/workflow/human-input").WorkflowHumanInputRequest
  responderId: string
  callerDeviceId: string
  values: Record<string, import("@/types/workflow/human-input").HumanInputValue>
}): Promise<
  | {
      ok: true
      values: Record<string, import("@/types/workflow/human-input").HumanInputValue>
      promotedIds: string[]
      stagingRefs: string[]
    }
  | { ok: false; message: string }
> {
  const fileFields = input.request.fields.filter(
    (field) => field.type === "file" || field.type === "file-list"
  )
  if (fileFields.length === 0) {
    return { ok: true, values: input.values, promotedIds: [], stagingRefs: [] }
  }

  const { resolveAttachmentRef } = await import("@/lib/db/session-attachment-uploads")
  const { deleteHumanInputFiles, promoteHumanInputFile } =
    await import("@/lib/db/workflow-human-input-files")
  const values = { ...input.values }
  const promotedIds: string[] = []
  const stagingRefs: string[] = []
  const now = Date.now()

  try {
    for (const field of fileFields) {
      const raw = input.values[field.id]
      if (raw === null || raw === undefined || raw === "") continue
      let refs: string[]
      if (field.type === "file-list") {
        if (!Array.isArray(raw) || !raw.every((ref): ref is string => typeof ref === "string")) {
          await deleteHumanInputFiles(promotedIds)
          return { ok: false, message: `Invalid file value for ${field.id}` }
        }
        refs = raw
      } else if (typeof raw === "string") {
        refs = [raw]
      } else {
        await deleteHumanInputFiles(promotedIds)
        return { ok: false, message: `Invalid file value for ${field.id}` }
      }
      if (field.type === "file" && refs.length !== 1) {
        await deleteHumanInputFiles(promotedIds)
        return { ok: false, message: `Only one file is allowed for ${field.id}` }
      }
      if (field.maxFiles !== undefined && refs.length > field.maxFiles) {
        await deleteHumanInputFiles(promotedIds)
        return { ok: false, message: `Too many files for ${field.id}` }
      }

      const durableRefs: string[] = []
      for (const ref of refs) {
        const staged = await resolveAttachmentRef(ref, {
          sessionId: `human-input:${input.request.id}`,
          deviceId: input.callerDeviceId,
        })
        if (!staged || !humanInputFileMatchesAccept(field.accept, staged)) {
          await deleteHumanInputFiles(promotedIds)
          return { ok: false, message: `File validation failed for ${field.id}` }
        }
        const retentionDays = field.sensitive ? (input.request.sensitiveRetentionDays ?? 30) : 30
        const promoted = await promoteHumanInputFile({
          accountId: input.request.accountId,
          requestId: input.request.id,
          responderId: input.responderId,
          fieldId: field.id,
          name: staged.name,
          mediaType: staged.mediaType,
          size: staged.size,
          hash: staged.hash,
          bytes: staged.bytes as Uint8Array,
          expiresAt:
            now + Math.min(retentionDays * 24 * 60 * 60 * 1_000, HUMAN_INPUT_FILE_RETENTION_MS),
          now,
        })
        promotedIds.push(promoted.id)
        stagingRefs.push(ref)
        durableRefs.push(promoted.ref)
      }
      values[field.id] = field.type === "file-list" ? durableRefs : (durableRefs[0] ?? null)
    }
    return { ok: true, values, promotedIds, stagingRefs }
  } catch {
    await deleteHumanInputFiles(promotedIds)
    return { ok: false, message: "File validation failed" }
  }
}

/** List only requests assigned to the verified paired device. */
async function workflowHumanInputList(
  payload: Record<string, unknown>
): Promise<{ requests: unknown[] }> {
  const callerDeviceId = callerDeviceIdFor("workflow_human_input_list", payload)
  const { isHumanInputAssigned, listPendingHumanInputRequests } =
    await import("@/lib/db/workflow-human-input")
  const pending = await listPendingHumanInputRequests()
  return {
    requests: pending
      .filter((request) =>
        isHumanInputAssigned(request, companionHumanInputActor(callerDeviceId, request.initiatorId))
      )
      .map((request) => ({
        id: request.id,
        status: request.status,
        runId: request.runId,
        workflowId: request.workflowId,
        stepId: request.stepId,
        title: request.title,
        ...(request.message ? { message: request.message } : {}),
        fields: request.fields,
        actions: request.actions,
        completionPolicy: request.completionPolicy,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      })),
  }
}

/** Submit a form response as the JWT-bound paired device; actor fields in the
 * client payload are ignored so a device cannot impersonate a member/group. */
async function workflowHumanInputSubmit(
  payload: Record<string, unknown>
): Promise<{ ok: boolean; completed?: boolean; reason?: string; message?: string }> {
  const callerDeviceId = callerDeviceIdFor("workflow_human_input_submit", payload)
  const requestId = payload.requestId
  if (typeof requestId !== "string" || !requestId) {
    throw new Error("workflow_human_input_submit.requestId is required")
  }
  const actionId = payload.actionId
  if (typeof actionId !== "string" || !actionId) {
    throw new Error("workflow_human_input_submit.actionId is required")
  }
  const values = payload.values
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("workflow_human_input_submit.values must be an object")
  }
  const { getHumanInputRequest, submitHumanInput } = await import("@/lib/db/workflow-human-input")
  const request = await getHumanInputRequest(requestId)
  if (!request) return { ok: false, reason: "not-found" }
  const actor = companionHumanInputActor(callerDeviceId, request.initiatorId)
  const promoted = await promoteCompanionHumanInputFiles({
    request,
    responderId: actor.id,
    callerDeviceId,
    values: values as Record<string, import("@/types/workflow/human-input").HumanInputValue>,
  })
  if (!promoted.ok) return { ok: false, reason: "invalid-values", message: promoted.message }
  let result: Awaited<ReturnType<typeof submitHumanInput>>
  try {
    result = await submitHumanInput({
      requestId,
      actor,
      actionId,
      values: promoted.values,
    })
  } catch (error) {
    const { deleteHumanInputFiles } = await import("@/lib/db/workflow-human-input-files")
    await deleteHumanInputFiles(promoted.promotedIds)
    throw error
  }
  if (!result.ok) {
    const { deleteHumanInputFiles } = await import("@/lib/db/workflow-human-input-files")
    await deleteHumanInputFiles(promoted.promotedIds)
  } else if (promoted.stagingRefs.length > 0) {
    const { consumeAttachmentRefs } = await import("@/lib/db/session-attachment-uploads")
    await consumeAttachmentRefs(promoted.stagingRefs)
  }
  return result.ok
    ? { ok: true, completed: result.completed }
    : { ok: false, reason: result.reason, ...(result.message ? { message: result.message } : {}) }
}

/** Feed one chunk of a remote-step result into the broker (ADR-0061 P3).
 *  The responder identity is the JWT-injected `callerDeviceId`; the broker
 *  rejects answers from any device other than the request's target. */
async function workflowStepResult(
  payload: Record<string, unknown>
): Promise<{ ok: boolean; complete?: boolean; reason?: string }> {
  const deviceId = payload.callerDeviceId as string | undefined
  if (!deviceId) throw new Error("workflow_step_result.callerDeviceId is required")
  const requestId = payload.requestId as string | undefined
  if (!requestId) throw new Error("workflow_step_result.requestId is required")
  const { resolveRemoteStep } = await import("@/lib/workflow/runtime/remote-step-broker")
  const outcome = await resolveRemoteStep(deviceId, {
    requestId,
    seq: payload.seq as number,
    total: payload.total as number,
    chunk: payload.chunk as string,
  })
  return outcome.ok
    ? { ok: true, complete: outcome.complete }
    : { ok: false, reason: outcome.reason }
}

/** Hard cap on the persisted capability list — well above the core vocabulary
 *  plus any sane number of `plugin:<id>` tags; bounds a hostile payload. */
const MAX_REPORTED_CAPABILITIES = 64

/** Persist a paired device's platform capability manifest (ADR-0060) onto its
 *  `pairedDevices` row. `callerDeviceId` comes from the Rust RPC layer (JWT
 *  identity, spoof-proof); the capability list is validated + capped here. */
async function deviceCapabilitiesReport(payload: Record<string, unknown>): Promise<null> {
  const deviceId = payload.callerDeviceId as string | undefined
  if (!deviceId) throw new Error("device_capabilities_report.callerDeviceId is required")
  const raw = payload.capabilities
  if (!Array.isArray(raw)) {
    throw new Error("device_capabilities_report.capabilities must be an array")
  }
  const capabilities = raw.filter(isCapabilityId).slice(0, MAX_REPORTED_CAPABILITIES)
  await recordDeviceCapabilities(deviceId, capabilities)
  return null
}

/** Enqueue a twin ingest job. The desktop's twin scheduler picks it up
 *  asynchronously and walks the redact → chunk → embed → persist pipeline. */
async function twinIngestSource(payload: Record<string, unknown>): Promise<{ jobId: string }> {
  if (payload.kind === "twin_draft_accept" || payload.kind === "twin_draft_reject") {
    const result = await reviewTwinDraft({
      action: payload.kind === "twin_draft_accept" ? "accept" : "reject",
      draftId: String(payload.draftId ?? ""),
    })
    return { jobId: result.acceptedAsId ?? `review:${String(payload.draftId ?? "")}` }
  }
  const twinId = payload.twinId as string | undefined
  if (!twinId) throw new Error("twin_ingest_source.twinId is required")
  if (typeof payload.text === "string" || typeof payload.base64 === "string") {
    const registered = await registerInlineTwinSources(payload, twinId)
    const job = await enqueueIngestJob({ twinId, sourceIds: registered.sourceIds })
    return { jobId: job.id }
  }
  // Scope the ingest to the caller-supplied source ids when present; an
  // omitted or empty list means "ingest every source attached to the twin"
  // (the desktop scheduler's default). Reject a malformed `sourceIds` rather
  // than silently widening the scope.
  const rawSourceIds = payload.sourceIds
  let sourceIds: string[] = []
  if (rawSourceIds !== undefined && rawSourceIds !== null) {
    if (!Array.isArray(rawSourceIds) || rawSourceIds.some((s) => typeof s !== "string")) {
      throw new Error("twin_ingest_source.sourceIds must be an array of strings")
    }
    sourceIds = rawSourceIds as string[]
  }
  const job = await enqueueIngestJob({
    twinId,
    sourceIds,
  })
  return { jobId: job.id }
}

// ---------------------------------------------------------------------------
// Workflow CRUD (Wave 4.1)
// ---------------------------------------------------------------------------

async function workflowCreate(payload: Record<string, unknown>): Promise<{ workflow: unknown }> {
  const draft = payload.draft as WorkflowDraft | undefined
  if (!draft || typeof draft !== "object") {
    throw new Error("workflow_create.draft is required")
  }
  const workflow = await createWorkflow(draft)
  return { workflow }
}

async function workflowUpdate(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  const patch = payload.patch as WorkflowPatch | undefined
  if (!id) throw new Error("workflow_update.id is required")
  if (!patch || typeof patch !== "object") {
    throw new Error("workflow_update.patch is required")
  }
  await updateWorkflow(id, patch)
  return null
}

async function workflowDelete(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  if (!id) throw new Error("workflow_delete.id is required")
  await deleteWorkflow(id)
  return null
}

async function workflowRunList(payload: Record<string, unknown>): Promise<{ runs: unknown[] }> {
  const workflowId = payload.workflowId as string | undefined
  const limit = typeof payload.limit === "number" ? payload.limit : undefined
  const offset = typeof payload.offset === "number" ? payload.offset : undefined
  const runs = await listWorkflowRuns({ workflowId, limit, offset })
  return { runs }
}

async function workflowCancelRun(
  payload: Record<string, unknown>
): Promise<{ cancelled: boolean; live: boolean; mode: string }> {
  const runId = payload.runId as string | undefined
  if (!runId) throw new Error("workflow_cancel_run.runId is required")
  // Shared cancel ladder (ADR 0061 P4): local abort → lease signal to the
  // owning executor → soft-cancel with companion fan-out.
  const { cancelWorkflowRun } = await import("@/lib/workflow/runtime/cancel-run")
  return cancelWorkflowRun(runId, "cancelled via Companion API")
}

async function workflowScheduleSet(
  payload: Record<string, unknown>,
  enabled: boolean
): Promise<null> {
  const triggerId = payload.triggerId as string | undefined
  if (!triggerId) {
    throw new Error(`workflow_schedule_${enabled ? "resume" : "pause"}.triggerId is required`)
  }
  const source = createWorkflowSource()
  if (enabled) {
    await source.resume(triggerId)
  } else {
    await source.pause(triggerId)
  }
  return null
}

// ---------------------------------------------------------------------------
// Twin source CRUD + job control (Wave 4.1)
// ---------------------------------------------------------------------------

async function twinDelete(payload: Record<string, unknown>): Promise<{ result: unknown }> {
  const id = payload.id as string | undefined
  if (!id) throw new Error("twin_delete.id is required")
  const result = await removeTwin(id)
  if (!result.ok) throw new Error(`twin_delete.${result.stage}: ${result.error}`)
  return { result: result.value ?? null }
}

async function twinSourceList(payload: Record<string, unknown>): Promise<{ sources: unknown[] }> {
  const twinId = payload.twinId as string | undefined
  if (!twinId) throw new Error("twin_source_list.twinId is required")
  const sources = await listTwinSourcesByTwin(twinId)
  return { sources }
}

async function twinSourceUpdate(payload: Record<string, unknown>): Promise<{ source: unknown }> {
  const id = payload.id as string | undefined
  const patch = payload.patch as Partial<Omit<TwinSource, "id" | "twinId">> | undefined
  if (!id) throw new Error("twin_source_update.id is required")
  if (!patch || typeof patch !== "object") {
    throw new Error("twin_source_update.patch is required")
  }
  const source = await updateTwinSource(id, patch)
  return { source: source ?? null }
}

async function twinSourceDelete(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  if (!id) throw new Error("twin_source_delete.id is required")
  const result = await removeTwinSource(id)
  if (!result.ok) throw new Error(`twin_source_delete.${result.stage}: ${result.error}`)
  return null
}

/** Create a new twin. Closes the "remote can delete but not create" gap. */
async function twinCreate(payload: Record<string, unknown>): Promise<{ twin: unknown }> {
  const input = payload.twin as TwinInput | undefined
  if (!input || typeof input !== "object") {
    throw new Error("twin_create.twin is required")
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new Error("twin_create.twin.name is required")
  }
  const twin = await createTwin(input)
  return { twin }
}

/** Create a new twin source row (the remote add-path that `twin_ingest_source`
 *  never provided — ingest scopes existing sources but does not create them). */
async function twinSourceCreate(
  payload: Record<string, unknown>
): Promise<{ source: unknown; jobId?: string; reused: boolean }> {
  const draft = payload.source as TwinSourceDraft | undefined
  if (draft && typeof draft === "object") {
    if (typeof draft.twinId !== "string" || draft.twinId.length === 0) {
      throw new Error("twin_source_create.source.twinId is required")
    }
    const registered = await registerTwinSource(draft)
    const shouldIngest =
      payload.enqueueIngest === true && (registered.created || registered.revived)
    const job = shouldIngest
      ? await enqueueIngestJob({ twinId: draft.twinId, sourceIds: [registered.source.id] })
      : undefined
    return {
      source: registered.source,
      ...(job ? { jobId: job.id } : {}),
      reused: !registered.created && !registered.revived,
    }
  }
  const twinId = payload.twinId as string | undefined
  if (!twinId) throw new Error("twin_source_create.source or twinId is required")
  const registered = await registerInlineTwinSources(payload, twinId)
  const job = await enqueueIngestJob({ twinId, sourceIds: registered.sourceIds })
  return { source: registered.sources[0] ?? null, jobId: job.id, reused: registered.reused }
}

async function twinDraftReview(payload: Record<string, unknown>): Promise<unknown> {
  const draftId = payload.draftId as string | undefined
  const action = payload.action
  if (!draftId) throw new Error("twin_draft_review.draftId is required")
  if (action !== "accept" && action !== "reject") {
    throw new Error("twin_draft_review.action must be accept or reject")
  }
  return reviewTwinDraft({
    action,
    draftId,
    ...(typeof payload.reviewerNote === "string" ? { reviewerNote: payload.reviewerNote } : {}),
  })
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBase64(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function retrievalProfileDekExport(payload: Record<string, unknown>) {
  const profileId = payload.profileId
  const protocolVersion = payload.contentProtocolVersion
  if (typeof profileId !== "string" || !profileId.trim()) {
    throw new Error("retrieval_profile_dek_export.profileId is required")
  }
  if (protocolVersion !== 1) {
    throw new Error("upgrade_required: retrieval content protocol v1 is required")
  }
  const exported = await createProfileDekStore().exportForPairing(profileId, {
    authenticated: true,
    protocolVersion,
  })
  try {
    return {
      protocolVersion: 1,
      profileId: exported.profileId,
      keyId: exported.keyId,
      rawKey: encodeBase64(exported.rawKey),
    }
  } finally {
    exported.rawKey.fill(0)
  }
}

async function extractImageText(base64: string, mimeType: string): Promise<string> {
  const [{ detectPlatform }, tauri] = await Promise.all([
    import("@/lib/platform/detect"),
    import("@/lib/tauri"),
  ])
  const platform = detectPlatform()
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (platform === "headless") return tauri.transport.call<T>(command, args)
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<T>(command, args)
  }
  const available = await call<string[]>("ocr_list_available_backends")
  const backend = ["apple-vision", "windows-media-ocr", "ocrs", "paddle-ocr", "tesseract"].find(
    (candidate) => available.includes(candidate)
  )
  if (!backend) throw new Error("No local OCR backend is available")
  const result = await call<{ text: string }>("ocr_extract_native", {
    payload: {
      backend,
      bytes: Array.from(decodeBase64(base64)),
      mime_type: mimeType,
      languages: ["en", "zh"],
    },
  })
  if (!result.text.trim()) throw new Error("OCR returned no text")
  return result.text
}

async function registerInlineTwinSources(payload: Record<string, unknown>, twinId: string) {
  let staged: Array<{
    kind: TwinSource["kind"]
    format: TwinSource["format"]
    title: string
    text: string
    bytes: number
    tags?: string[]
    speakers?: string[]
  }> = []
  if (typeof payload.text === "string") {
    staged = [
      {
        kind: "document",
        format: "markdown",
        title: typeof payload.filename === "string" ? payload.filename : "Mobile paste",
        text: payload.text,
        bytes: payload.text.length,
      },
    ]
  } else if (typeof payload.base64 === "string") {
    const filename = typeof payload.filename === "string" ? payload.filename : "Mobile capture.png"
    const mime = typeof payload.mime === "string" ? payload.mime : "application/octet-stream"
    if (mime.startsWith("image/")) {
      const text = await extractImageText(payload.base64, mime)
      staged = [
        {
          kind: "document",
          format: "markdown",
          title: filename,
          text,
          bytes: decodeBase64(payload.base64).byteLength,
          tags: ["image", "ocr"],
        },
      ]
    } else {
      const file = new File([new Uint8Array(decodeBase64(payload.base64)).buffer], filename, {
        type: mime,
      })
      const result = await stageFile(file, twinId)
      if (result.error) throw new Error(`Twin source staging failed: ${result.error.code}`)
      staged = result.staged
    }
  } else {
    throw new Error("Twin inline source requires text or base64")
  }
  const results = await Promise.all(
    staged.map((item) =>
      registerTwinSource({
        twinId,
        kind: item.kind,
        format: item.format,
        source: item.text,
        title: item.title,
        bytes: item.bytes,
        redacted: false,
        tags: item.tags,
        speakers: item.speakers,
      })
    )
  )
  return {
    sources: results.map((result) => result.source),
    sourceIds: results.map((result) => result.source.id),
    reused: results.every((result) => !result.created && !result.revived),
  }
}

/**
 * Unified twin-profile mutation. A single coarse RPC arm covers the whole
 * persona-edit surface (voice summary, entities, playbooks, style samples,
 * reset) via a discriminated `op`, so the remote device has parity with the
 * desktop profile editor without exploding the wire surface into ~15 arms.
 * Returns the updated profile.
 */
async function twinProfileUpdate(payload: Record<string, unknown>): Promise<{ profile: unknown }> {
  const twinId = payload.twinId as string | undefined
  const op = payload.op as string | undefined
  if (!twinId) throw new Error("twin_profile_update.twinId is required")
  if (!op) throw new Error("twin_profile_update.op is required")

  const requireString = (field: string): string => {
    const v = payload[field]
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`twin_profile_update.${field} is required for op=${op}`)
    }
    return v
  }
  const requireObject = <T>(field: string): T => {
    const v = payload[field]
    if (!v || typeof v !== "object") {
      throw new Error(`twin_profile_update.${field} is required for op=${op}`)
    }
    return v as T
  }
  const requireBool = (field: string): boolean => {
    const v = payload[field]
    if (typeof v !== "boolean") {
      throw new Error(`twin_profile_update.${field} must be boolean for op=${op}`)
    }
    return v
  }
  const requirePiiSafe = <T>(field: string, value: T): T => {
    if (!hasNoLeakingPiiDeep(value)) {
      throw new Error(`twin_profile_update.${field} contains unredacted PII`)
    }
    return value
  }

  let profile: unknown
  switch (op) {
    case "setVoiceSummary":
      profile = await setVoiceSummary(
        twinId,
        requirePiiSafe("voiceSummary", requireString("voiceSummary"))
      )
      // setVoiceSummary returns void — re-read for a consistent envelope below.
      break
    case "reset":
      profile = await resetTwinProfile(twinId)
      break
    case "addEntity":
      profile = await addEntity(
        twinId,
        requirePiiSafe("entity", requireObject<ProfileEntity>("entity"))
      )
      break
    case "updateEntity":
      profile = await updateEntity(
        twinId,
        requireString("name"),
        requirePiiSafe("entity", requireObject<ProfileEntity>("entity"))
      )
      break
    case "removeEntity":
      profile = await removeEntity(twinId, requireString("name"))
      break
    case "setEntityPinned":
      profile = await setEntityPinned(twinId, requireString("name"), requireBool("pinned"))
      break
    case "addPlaybook":
      profile = await addPlaybook(
        twinId,
        requirePiiSafe("playbook", requireObject<Playbook>("playbook"))
      )
      break
    case "updatePlaybook":
      profile = await updatePlaybook(
        twinId,
        requireString("playbookId"),
        requirePiiSafe("playbook", requireObject<Playbook>("playbook"))
      )
      break
    case "removePlaybook":
      profile = await removePlaybook(twinId, requireString("playbookId"))
      break
    case "setPlaybookPinned":
      profile = await setPlaybookPinned(twinId, requireString("playbookId"), requireBool("pinned"))
      break
    case "addStyleSample":
      profile = await addStyleSample(
        twinId,
        requirePiiSafe("sample", requireObject<StyleSample>("sample"))
      )
      break
    case "updateStyleSample":
      profile = await updateStyleSample(
        twinId,
        requireString("sampleId"),
        requirePiiSafe("sample", requireObject<StyleSample>("sample"))
      )
      break
    case "removeStyleSample":
      profile = await removeStyleSample(twinId, requireString("sampleId"))
      break
    case "setStyleSamplePinned":
      profile = await setStyleSamplePinned(twinId, requireString("sampleId"), requireBool("pinned"))
      break
    default:
      throw new Error(`twin_profile_update.op is not supported: ${op}`)
  }
  // `setVoiceSummary` resolves to void; re-read so every op returns the profile.
  if (op === "setVoiceSummary") {
    profile = (await getDb().twinProfile.get(twinId)) ?? null
  }
  return { profile: profile ?? null }
}

async function twinJobStatus(payload: Record<string, unknown>): Promise<unknown> {
  const jobId = payload.jobId as string | undefined
  if (jobId) {
    const job = await getTwinJob(jobId)
    return { job: job ?? null }
  }
  const twinId = payload.twinId as string | undefined
  if (!twinId) {
    throw new Error("twin_job_status requires jobId or twinId")
  }
  const jobs = await listActiveJobsByTwin(twinId)
  return { jobs }
}

async function twinJobAction(
  payload: Record<string, unknown>,
  action: "cancel" | "pause" | "resume" | "retry"
): Promise<null> {
  const jobId = payload.jobId as string | undefined
  if (!jobId) throw new Error(`twin_job_${action}.jobId is required`)
  switch (action) {
    case "cancel":
      await cancelJob(jobId, payload.reason as string | undefined)
      break
    case "pause":
      await pauseJob(jobId)
      break
    case "resume":
      await resumeJob(jobId)
      break
    case "retry":
      await retryDeadLetterJob(jobId)
      break
  }
  return null
}

// ---------------------------------------------------------------------------
// External agents (ADR-0056, Wave 4)
// ---------------------------------------------------------------------------

/** Compact, wire-safe projection of one external agent for the phone list. */
interface ExternalAgentSummary {
  id: string
  name: string
  protocol: ExternalAgentProtocol
  transport: string
  enabled: boolean
  defaultPermissionMode: AcpPermissionMode
}

/** Lazily reach the desktop Zustand store. Dynamic so the heavy
 *  persist-backed store (and `localStorage`) is only touched on the desktop
 *  dispatch path, never at module import time (keeps the headless/test paths
 *  and the SSR bundle clean). */
async function getExternalAgentStoreState() {
  const { useExternalAgentStore } = await import("@/stores/agent/external-agent-store")
  return useExternalAgentStore.getState()
}

/** Read-only projection of the desktop's configured external agents. Mirrors
 *  the `twin_profile_get` read arm — invoked directly via `transport.call`,
 *  not through the outbound queue. */
async function externalAgentList(): Promise<{ agents: ExternalAgentSummary[] }> {
  const store = await getExternalAgentStoreState()
  const agents: ExternalAgentSummary[] = store.getAllAgents().map((agent) => ({
    id: agent.id,
    name: agent.name,
    protocol: agent.protocol,
    transport: agent.transport,
    enabled: agent.enabled,
    defaultPermissionMode: agent.defaultPermissionMode ?? "default",
  }))
  return { agents }
}

/**
 * Enable/disable an external agent and/or change its default permission mode
 * from the phone. The permission mode is clamped through
 * {@link adaptPermissionMode} against the agent's own protocol, so the phone
 * can never persist a mode the backend can't enforce (e.g. `dontAsk` on
 * Codex) — the desktop store is the authority, so the clamp lives here.
 *
 * The write itself goes through the lifecycle service rather than the store.
 * Writing to the store directly persisted the new value and left the runtime
 * untouched: disabling an agent from a paired device flipped the toggle while
 * the child process kept running, and re-enabling it did nothing until the
 * desktop app was restarted.
 */
async function externalAgentUpdate(
  payload: Record<string, unknown>
): Promise<{ agent: ExternalAgentSummary | null }> {
  const id = payload.id as string | undefined
  if (!id) throw new Error("external_agent_update.id is required")
  const patch = payload.patch as { enabled?: unknown; defaultPermissionMode?: unknown } | undefined
  if (!patch || typeof patch !== "object") {
    throw new Error("external_agent_update.patch is required")
  }

  const store = await getExternalAgentStoreState()
  const agent = store.getAgent(id)
  if (!agent) throw new Error(`external_agent_update: agent not found: ${id}`)

  const updates: UpdateExternalAgentInput = {}
  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    if (typeof patch.enabled !== "boolean") {
      throw new Error("external_agent_update.patch.enabled must be boolean")
    }
    updates.enabled = patch.enabled
  }
  if (Object.prototype.hasOwnProperty.call(patch, "defaultPermissionMode")) {
    const requested = patch.defaultPermissionMode
    if (!isAcpPermissionMode(requested)) {
      throw new Error("external_agent_update.patch.defaultPermissionMode is invalid")
    }
    // Clamp toward restriction for the agent's protocol — never escalate past
    // what the backend can enforce.
    updates.defaultPermissionMode = adaptPermissionMode(requested, agent.protocol).mode
  }
  if (Object.keys(updates).length === 0) {
    throw new Error("external_agent_update.patch has no editable fields")
  }

  const { getExternalAgentLifecycleService } =
    await import("@/lib/ai/agent/external/lifecycle/service")
  const lifecycle = await getExternalAgentLifecycleService()
  await lifecycle.updateConfig(id, updates)

  const next = store.getAgent(id)
  return {
    agent: next
      ? {
          id: next.id,
          name: next.name,
          protocol: next.protocol,
          transport: next.transport,
          enabled: next.enabled,
          defaultPermissionMode: next.defaultPermissionMode ?? "default",
        }
      : null,
  }
}

const ACP_PERMISSION_MODES: readonly AcpPermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
]

function isAcpPermissionMode(value: unknown): value is AcpPermissionMode {
  return typeof value === "string" && ACP_PERMISSION_MODES.includes(value as AcpPermissionMode)
}

// ---------------------------------------------------------------------------
// Settings — per-conversation overrides (Wave 4.1)
// ---------------------------------------------------------------------------

/**
 * Two payload shapes:
 *
 *  - legacy `{ input }` — a plain upsert, the pre-ADR-0131 mobile settings
 *    form's only move. Kept because an older phone build still sends it.
 *  - `{ mutation }` (ADR-0131) — one {@link ConversationOverrideMutation}
 *    applied with FULL host semantics: audit rows, the assignment trail, and
 *    assignment ↔ routing sync all behave exactly as if the operator had made
 *    the change on this desktop. `via` is stamped from the authenticated
 *    caller device (injected by the Rust layer, never trusted from the raw
 *    payload) so a phone-originated change is attributable.
 */
async function conversationOverridesUpdate(
  payload: Record<string, unknown>
): Promise<{ override: unknown }> {
  const mutation = payload.mutation
  if (mutation !== undefined) {
    const { applyConversationOverrideMutation, isConversationOverrideMutation } =
      await import("@/lib/connectors/inbox-writes/override-mutation")
    if (!isConversationOverrideMutation(mutation)) {
      throw new Error("conversation_overrides_update.mutation is malformed")
    }
    const deviceId = payload.callerDeviceId as string | undefined
    const override = await applyConversationOverrideMutation(mutation, {
      via: deviceId ? `device:${deviceId}` : undefined,
    })
    return { override: override ?? null }
  }
  const input = payload.input as ConversationOverrideInput | undefined
  if (!input || typeof input !== "object") {
    throw new Error("conversation_overrides_update requires `mutation` or legacy `input`")
  }
  const override = await upsertByConversationKey(input)
  return { override }
}

// ---------------------------------------------------------------------------
// App-data backup (Wave 4.1)
// ---------------------------------------------------------------------------

async function backupExport(
  payload: Record<string, unknown>
): Promise<{ package: BackupPackageV3 }> {
  if (payload.plaintextConfirmed !== true) {
    throw new Error("backup_export requires explicit plaintext confirmation")
  }
  const opts = (payload.options as Partial<ExportOptions> | undefined) ?? {}
  const exportOptions: ExportOptions = {
    includeSessions: opts.includeSessions ?? true,
    // Never ride secrets to a remote client by default.
    includeApiKey: false,
    includeBuiltIns: opts.includeBuiltIns ?? false,
  }
  const pkg = await buildBackupPackage(exportOptions)
  return { package: pkg }
}

async function backupImport(payload: Record<string, unknown>): Promise<{ summary: unknown }> {
  const pkg = payload.package as BackupPackageV3 | undefined
  if (!pkg || typeof pkg !== "object") {
    throw new Error("backup_import.package is required")
  }
  const opts = (payload.options as Partial<ImportOptions> | undefined) ?? {}
  const mergeStrategy = (opts.mergeStrategy ?? "skip") as ImportMergeStrategy
  const importOptions: ImportOptions = {
    mergeStrategy,
    includeSessions: opts.includeSessions ?? true,
    includeApiKey: false,
    retrievalDekPassphrase:
      typeof opts.retrievalDekPassphrase === "string" ? opts.retrievalDekPassphrase : undefined,
  }
  const summary = await applyBackupPackage(pkg, importOptions)
  return { summary }
}

void getSettings // keep import alive for tests that mock the module
