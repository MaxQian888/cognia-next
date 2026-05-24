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

async function pluginSetEnabled(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  const enabled = payload.enabled as boolean | undefined
  if (!id) throw new Error("plugin_set_enabled.id is required")
  if (typeof enabled !== "boolean") throw new Error("plugin_set_enabled.enabled must be boolean")
  await getDb().plugins.update(id, { enabled, updatedAt: Date.now() })
  return null
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
 *  the OS and routes it to a selected chat session. */
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
  const job = await enqueueIngestJob({
    twinId,
    sourceIds: [],
  })
  return { jobId: job.id }
}

void getSettings // keep import alive for tests that mock the module
