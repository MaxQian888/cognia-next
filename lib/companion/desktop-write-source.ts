"use client"

/**
 * Desktop-side counterpart of the Rust
 * `companion::desktop_writes_bridge` (Wave 2).
 *
 * The phone hits one of 8 mutating RPCs (`character_upsert`, `character_delete`,
 * `character_bind_twin`, `skill_set_enabled`, `plugin_set_enabled`,
 * `adapter_update_policy`, `app_settings_update`, `twin_profile_get`)
 * against the desktop's Rust HTTP server. The Rust handler emits a
 * unified `companion://desktop-write-request` event with `{ command,
 * payload }`. This module dispatches by command name, runs the matching
 * Dexie operation, and ships the result back via the
 * `companion_desktop_write_response` Tauri command.
 *
 * Modeled after `lib/companion/desktop-message-source.ts` — same install
 * guard, same bridge-injection pattern for tests.
 */

import { createCharacter, deleteCharacter, updateCharacter } from "@/lib/db/characters"
import type { CharacterDraft } from "@/lib/db/characters"
import { approveDraft, rejectDraft } from "@/lib/db/connector-drafts"
import { attachSession, detachSession } from "@/lib/companion/remote-attach-registry"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { getDb } from "@/lib/db/schema"
import { getSettings, saveSettings } from "@/lib/db/settings"
import type { AppSettings, StoredMessage } from "@/lib/claude/types"
import { enqueueIngestJob } from "@/lib/twin/ingest"
import { dispatchTrigger } from "@/lib/workflow/runtime/trigger-bridge"
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflowRuns,
  updateWorkflow,
  type WorkflowDraft,
  type WorkflowPatch,
} from "@/lib/db/workflows"
import { createWorkflowSource } from "@/lib/scheduler/sources/workflow-source"
import { requestCancelRun } from "@/lib/workflow/runtime/run-cancel-registry"
import { createTwin, deleteTwin, type TwinInput } from "@/lib/db/twins"
import {
  createTwinSource,
  deleteTwinSource,
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
import type {
  AcpPermissionMode,
  ExternalAgentProtocol,
  UpdateExternalAgentInput,
} from "@/types/agent/external-agent"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"

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

  return () => {
    installed = false
    unlisten()
  }
}

async function respond(req: DesktopWriteRequestEvent, bridge: TauriBridge): Promise<void> {
  const { requestId, command, payload } = req
  try {
    const result = await dispatchCommand(command, payload)
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
  payload: Record<string, unknown>
): Promise<unknown> {
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
    case "adapter_update_policy":
      return adapterUpdatePolicy(payload)
    case "app_settings_update":
      return appSettingsUpdate(payload)
    case "twin_profile_get":
      return twinProfileGet(payload)
    // Mobile outbound-queue commands (Gap 3 reconciliation) — these go
    // through the same generic desktop_writes_bridge but land in
    // subsystem-specific dispatch arms below. Production callers:
    //   - connector_send         → app/share-target/page.tsx
    //   - connector_approve_draft → components/mobile/connector/draft-approval-panel.tsx
    //   - connector_reject_draft  → components/mobile/connector/draft-approval-panel.tsx
    //   - workflow_trigger_manual → components/mobile/workflow/trigger-button.tsx
    //   - twin_ingest_source      → components/mobile/discover/twin-{sources,drafts}-panel.tsx
    case "connector_send":
      return connectorSend(payload)
    case "connector_approve_draft":
      return connectorApproveDraft(payload)
    case "connector_reject_draft":
      return connectorRejectDraft(payload)
    case "workflow_trigger_manual":
      return workflowTriggerManual(payload)
    case "twin_ingest_source":
      return twinIngestSource(payload)
    // Remote Session Control — attach / detach a remote watcher to a host
    // session so non-foreground `permission_request`s route to the phone
    // instead of being auto-denied. State lives in
    // `lib/companion/remote-attach-registry.ts`.
    case "session_attach":
      return sessionAttach(payload)
    case "session_detach":
      return sessionDetach(payload)
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

function sessionAttach(payload: Record<string, unknown>): null {
  const sessionId = payload.sessionId as string | undefined
  const deviceId = payload.deviceId as string | undefined
  if (!sessionId) throw new Error("session_attach.sessionId is required")
  if (!deviceId) throw new Error("session_attach.deviceId is required")
  attachSession(sessionId, deviceId)
  return null
}

function sessionDetach(payload: Record<string, unknown>): null {
  const sessionId = payload.sessionId as string | undefined
  const deviceId = payload.deviceId as string | undefined
  if (!sessionId) throw new Error("session_detach.sessionId is required")
  if (!deviceId) throw new Error("session_detach.deviceId is required")
  detachSession(sessionId, deviceId)
  return null
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

type ConnectorMode = "auto" | "manual" | "draft"

async function adapterUpdatePolicy(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  if (!id) throw new Error("adapter_update_policy.id is required")

  // Apply a per-field patch so we can distinguish "leave unchanged" from
  // "clear" — the latter is needed for quietHours, where a missing field
  // means "no quiet window". Dexie's `UpdateSpec` requires real types; we
  // narrow each branch.
  const updates: Partial<{
    defaultMode: ConnectorMode
    muted: boolean
    quietHours: { from: string; to: string; tz: string }
    updatedAt: number
  }> = { updatedAt: Date.now() }
  if (
    payload.defaultMode === "auto" ||
    payload.defaultMode === "manual" ||
    payload.defaultMode === "draft"
  ) {
    updates.defaultMode = payload.defaultMode
  }
  if (typeof payload.muted === "boolean") updates.muted = payload.muted

  const qh = payload.quietHours as { from?: unknown; to?: unknown; tz?: unknown } | null | undefined
  if (qh && typeof qh === "object") {
    if (typeof qh.from === "string" && typeof qh.to === "string" && typeof qh.tz === "string") {
      updates.quietHours = { from: qh.from, to: qh.to, tz: qh.tz }
    }
  }
  await getDb().adapterInstances.update(id, updates)
  // If the caller explicitly sent `quietHours: null`, drop the existing
  // window via a follow-up modify. Dexie's UpdateSpec rejects `null` for
  // non-nullable fields, so we hand-roll the unset.
  if (qh === null) {
    await getDb()
      .adapterInstances.where("id")
      .equals(id)
      .modify((row) => {
        delete row.quietHours
      })
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

// ---------------------------------------------------------------------------
// Mobile outbound-queue handlers (Gap 3 reconciliation)
// ---------------------------------------------------------------------------

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
  return { messageId: id }
}

/** Approve a pending connector draft so the connector outbound runner can
 *  pick it up for the real platform send. */
async function connectorApproveDraft(payload: Record<string, unknown>): Promise<null> {
  const draftId = payload.draftId as string | undefined
  if (!draftId) throw new Error("connector_approve_draft.draftId is required")
  await approveDraft(draftId)
  return null
}

/** Reject a pending connector draft. */
async function connectorRejectDraft(payload: Record<string, unknown>): Promise<null> {
  const draftId = payload.draftId as string | undefined
  if (!draftId) throw new Error("connector_reject_draft.draftId is required")
  await rejectDraft(draftId)
  return null
}

/** Trigger a workflow run manually from the mobile shell. Routes through the
 *  same orchestrator path the desktop UI / cron daemon use. The trigger
 *  `kind` matches the canonical workflow-node identifier `"trigger.manual"`
 *  declared in `types/workflow/visual.ts:WorkflowNodeKind`. */
async function workflowTriggerManual(payload: Record<string, unknown>): Promise<null> {
  const workflowId = payload.workflowId as string | undefined
  if (!workflowId) throw new Error("workflow_trigger_manual.workflowId is required")
  await dispatchTrigger({
    workflowId,
    kind: "trigger.manual",
    payload: payload.input ?? null,
    originAt: Date.now(),
  })
  return null
}

/** Enqueue a twin ingest job. The desktop's twin scheduler picks it up
 *  asynchronously and walks the redact → chunk → embed → persist pipeline. */
async function twinIngestSource(payload: Record<string, unknown>): Promise<{ jobId: string }> {
  const twinId = payload.twinId as string | undefined
  if (!twinId) throw new Error("twin_ingest_source.twinId is required")
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

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"])

async function workflowCancelRun(
  payload: Record<string, unknown>
): Promise<{ cancelled: boolean; live: boolean }> {
  const runId = payload.runId as string | undefined
  if (!runId) throw new Error("workflow_cancel_run.runId is required")
  // Abort a run executing in this runtime, if any.
  const live = requestCancelRun(runId, "cancelled via Companion API")
  // Soft-cancel: when the run is not live here (e.g. already finished, or owned
  // by another process) mark a non-terminal row as cancelled so the UI reflects
  // it. A live abort lets the orchestrator finalize the row itself.
  let cancelled = live
  if (!live) {
    const row = await getDb().workflowRuns.get(runId)
    if (row && !TERMINAL_RUN_STATUSES.has(row.status)) {
      await getDb().workflowRuns.update(runId, {
        status: "cancelled",
        completedAt: Date.now(),
      })
      cancelled = true
    }
  }
  return { cancelled, live }
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
  const result = await deleteTwin(id)
  return { result }
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
  await deleteTwinSource(id)
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
async function twinSourceCreate(payload: Record<string, unknown>): Promise<{ source: unknown }> {
  const draft = payload.source as TwinSourceDraft | undefined
  if (!draft || typeof draft !== "object") {
    throw new Error("twin_source_create.source is required")
  }
  if (typeof draft.twinId !== "string" || draft.twinId.length === 0) {
    throw new Error("twin_source_create.source.twinId is required")
  }
  const source = await createTwinSource(draft)
  return { source }
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

  let profile: unknown
  switch (op) {
    case "setVoiceSummary":
      profile = await setVoiceSummary(twinId, requireString("voiceSummary"))
      // setVoiceSummary returns void — re-read for a consistent envelope below.
      break
    case "reset":
      profile = await resetTwinProfile(twinId)
      break
    case "addEntity":
      profile = await addEntity(twinId, requireObject<ProfileEntity>("entity"))
      break
    case "updateEntity":
      profile = await updateEntity(
        twinId,
        requireString("name"),
        requireObject<ProfileEntity>("entity")
      )
      break
    case "removeEntity":
      profile = await removeEntity(twinId, requireString("name"))
      break
    case "setEntityPinned":
      profile = await setEntityPinned(twinId, requireString("name"), requireBool("pinned"))
      break
    case "addPlaybook":
      profile = await addPlaybook(twinId, requireObject<Playbook>("playbook"))
      break
    case "updatePlaybook":
      profile = await updatePlaybook(
        twinId,
        requireString("playbookId"),
        requireObject<Playbook>("playbook")
      )
      break
    case "removePlaybook":
      profile = await removePlaybook(twinId, requireString("playbookId"))
      break
    case "setPlaybookPinned":
      profile = await setPlaybookPinned(twinId, requireString("playbookId"), requireBool("pinned"))
      break
    case "addStyleSample":
      profile = await addStyleSample(twinId, requireObject<StyleSample>("sample"))
      break
    case "updateStyleSample":
      profile = await updateStyleSample(
        twinId,
        requireString("sampleId"),
        requireObject<StyleSample>("sample")
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

  store.updateAgent(id, updates)

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

async function conversationOverridesUpdate(
  payload: Record<string, unknown>
): Promise<{ override: unknown }> {
  const input = payload.input as ConversationOverrideInput | undefined
  if (!input || typeof input !== "object") {
    throw new Error("conversation_overrides_update.input is required")
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
  }
  const summary = await applyBackupPackage(pkg, importOptions)
  return { summary }
}

void getSettings // keep import alive for tests that mock the module
