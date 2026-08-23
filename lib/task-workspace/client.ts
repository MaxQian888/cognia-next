import { onTauriEvent, transport } from "@/lib/tauri"
import { recordTaskWorkspaceOutcome } from "@/lib/code-adoption/outcome"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import { projectTaskWorkspaceRun } from "./projection"
import type {
  ApplyOutcome,
  DownloadHandle,
  PatchSelection,
  PatchSet,
  ResourceChange,
  ResourceEvent,
  ResourceRead,
  ResourceTrackingPolicy,
  TaskResourceManifest,
  TaskResourceSummary,
  TaskRun,
  TaskWorkspace,
  TaskWorkspaceResourceEvent,
  TransferChunk,
  UploadHandle,
  WorkspaceBaseSpec,
  ManagedWorkspaceRecord,
  WorkspaceBundle,
  WorkspaceLifecyclePolicy,
} from "./types"

export const TASK_WORKSPACE_RESOURCE_EVENT = "task-workspace://resources-changed"

export interface BeginTaskWorkspaceTurn {
  taskId: string
  sessionId: string
  runId: string
  parentRunId?: string
  agentId: string
  agentKind: string
  workspaceRoot: string
  base?: WorkspaceBaseSpec
  workspaceKey?: string
  executionRunId?: string
  traceId?: string
  traceSpanId?: string
  turnId?: string
  attemptId?: string
  providerAttemptId?: string
  surface?: string
  trackingPolicy?: ResourceTrackingPolicy
}

function safeId(prefix: string, value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.:-]/g, "_")
  return `${prefix}${normalized}`.slice(0, 128)
}

export function taskIdForMessage(messageId: string): string {
  return safeId("task:", messageId)
}

export function runIdForTurn(sessionId: string, runId: number): string {
  return safeId("run:", `${sessionId}:${runId}`)
}

export async function beginTaskWorkspaceTurn(
  input: BeginTaskWorkspaceTurn
): Promise<TaskRun | null> {
  try {
    const run = await transport.call<TaskRun>("task_workspace_begin", { input })
    useTaskWorkspaceStore.getState().activate({
      taskId: run.taskId,
      runId: run.runId,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      executionRoot: run.executionRoot,
      state: run.state,
      ...(input.executionRunId ? { executionRunId: input.executionRunId } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.traceSpanId ? { traceSpanId: input.traceSpanId } : {}),
      ...(input.surface ? { surface: input.surface } : {}),
    })
    return run
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hostDeferred = /remote.control|not authorized|unknown.command|forbidden/i.test(message)
    if (!hostDeferred) throw error
    return null
  }
}

export async function settleTaskWorkspaceTurn(
  sessionId: string,
  chatRunId: number,
  finalState: "ready" | "failed" | "cancelled" = "ready"
): Promise<ResourceChange[] | null> {
  const active = useTaskWorkspaceStore.getState().activeBySession[sessionId]
  if (!active || active.runId !== runIdForTurn(sessionId, chatRunId)) return null
  try {
    const resources = await transport.call<ResourceChange[]>("task_workspace_settle", {
      runId: active.runId,
      finalState,
    })
    if (active.executionRunId || active.traceSpanId) {
      await getTaskResourceSummary(active.runId)
        .then((summary) =>
          projectTaskWorkspaceRun({
            ...(active.executionRunId ? { executionRunId: active.executionRunId } : {}),
            taskWorkspaceRunId: active.runId,
            ...(active.traceSpanId ? { traceSpanId: active.traceSpanId } : {}),
            ...(active.traceId ? { traceId: active.traceId } : {}),
            sessionId: active.sessionId,
            ...(active.surface ? { surface: active.surface } : {}),
            resources,
            summary,
          })
        )
        .catch(() => undefined)
    }
    useTaskWorkspaceStore.getState().reconcile(sessionId, resources)
    return resources
  } catch {
    return null
  }
}

export async function settleTaskWorkspaceRun(
  runId: string,
  finalState: "ready" | "failed" | "cancelled" = "ready"
): Promise<ResourceChange[]> {
  return transport.call<ResourceChange[]>("task_workspace_settle", {
    runId,
    finalState,
  })
}

export async function settleTaskWorkspaceRunWithProjection(
  runId: string,
  finalState: "ready" | "failed" | "cancelled" = "ready"
): Promise<ResourceChange[]> {
  const resources = await settleTaskWorkspaceRun(runId, finalState)
  const active = useTaskWorkspaceStore.getState().activeByRun[runId]
  if (active?.executionRunId || active?.traceSpanId) {
    await getTaskResourceSummary(runId)
      .then((summary) =>
        projectTaskWorkspaceRun({
          ...(active.executionRunId ? { executionRunId: active.executionRunId } : {}),
          taskWorkspaceRunId: runId,
          ...(active.traceSpanId ? { traceSpanId: active.traceSpanId } : {}),
          ...(active.traceId ? { traceId: active.traceId } : {}),
          sessionId: active.sessionId,
          ...(active.surface ? { surface: active.surface } : {}),
          resources,
          summary,
        })
      )
      .catch(() => undefined)
  }
  return resources
}

export function installTaskWorkspaceEventListener(): Promise<() => void> {
  return onTauriEvent<TaskWorkspaceResourceEvent>(TASK_WORKSPACE_RESOURCE_EVENT, (event) => {
    useTaskWorkspaceStore.getState().ingestEvent(event)
  })
}

export function getTaskWorkspace(taskId: string): Promise<TaskWorkspace | null> {
  return transport.call("task_workspace_get", { taskId })
}

export function listTaskWorkspaces(sessionId?: string): Promise<TaskWorkspace[]> {
  return transport.call("task_workspace_list", { sessionId })
}

export function getManagedWorkspace(workspaceId: string): Promise<ManagedWorkspaceRecord | null> {
  return transport.call("task_workspace_managed_get", { workspaceId })
}

export function listManagedWorkspaces(): Promise<ManagedWorkspaceRecord[]> {
  return transport.call("task_workspace_managed_list")
}

export function getWorkspaceBundle(bundleId: string): Promise<WorkspaceBundle | null> {
  return transport.call("task_workspace_bundle_get", { bundleId })
}

export function listWorkspaceBundles(): Promise<WorkspaceBundle[]> {
  return transport.call("task_workspace_bundle_list")
}

export function getWorkspaceLifecyclePolicy(): Promise<WorkspaceLifecyclePolicy> {
  return transport.call("task_workspace_policy_get")
}

export function setWorkspaceLifecyclePolicy(
  policy: WorkspaceLifecyclePolicy
): Promise<WorkspaceLifecyclePolicy> {
  return transport.call("task_workspace_policy_set", { policy })
}

export function pinManagedWorkspace(
  workspaceId: string,
  pinned: boolean
): Promise<ManagedWorkspaceRecord> {
  return transport.call("task_workspace_managed_pin", { workspaceId, pinned })
}

export function listTaskRuns(taskId: string): Promise<TaskRun[]> {
  return transport.call("task_workspace_list_runs", { taskId })
}

export function listTaskResources(taskId: string): Promise<ResourceChange[]> {
  return transport.call("task_workspace_list_resources", { taskId })
}

export function listTaskResourceEvents(
  runId: string,
  cursor?: number,
  limit = 200
): Promise<ResourceEvent[]> {
  return transport.call("task_workspace_list_resource_events", { runId, cursor, limit })
}

export function getTaskResourceSummary(runId: string): Promise<TaskResourceSummary> {
  return transport.call("task_workspace_get_resource_summary", { runId })
}

export function recordTaskResourceToolEvent(input: {
  runId: string
  path: string
  oldPath?: string
  kind: "created" | "modified" | "deleted" | "renamed"
  toolCallId?: string
}): Promise<ResourceEvent> {
  return transport.call("task_workspace_record_tool_event", input)
}

export function exportTaskResourceManifest(
  taskId: string,
  runId?: string
): Promise<TaskResourceManifest> {
  return transport.call("task_workspace_export_resource_manifest", { taskId, runId })
}

export function pinTaskWorkspace(taskId: string, pinned: boolean): Promise<TaskWorkspace> {
  return transport.call("task_workspace_pin", { taskId, pinned })
}

export function pruneTaskWorkspaces(): Promise<{
  removedTaskIds: string[]
  removedBlobCount: number
  reclaimedBytes: number
}> {
  return transport.call("task_workspace_prune")
}

export function readTaskResource(
  runId: string,
  relPath: string,
  options: { offset?: number; maxBytes?: number; allowSensitive?: boolean } = {}
): Promise<ResourceRead> {
  return transport.call("task_resource_read_text", { runId, relPath, ...options })
}

export function getTaskPatchSet(runId: string): Promise<PatchSet | null> {
  return transport.call("task_workspace_get_patch_set", { runId })
}

export function restoreTaskWorkspaceSnapshot(runId: string): Promise<TaskRun> {
  return transport.call("task_workspace_restore_snapshot", { runId })
}

export function readTaskResourceDiff(
  runId: string,
  path: string,
  allowSensitive = false
): Promise<string> {
  return transport.call("task_resource_read_diff", { runId, path, allowSensitive })
}

async function projectAdoptionOutcome(
  runId: string,
  kind: "apply" | "undo" | "keepCurrent"
): Promise<void> {
  try {
    const patch = await transport.call<PatchSet | null>("task_workspace_get_patch_set", { runId })
    if (patch) await recordTaskWorkspaceOutcome(patch, kind)
  } catch {
    // Adoption accounting is best-effort and must not change the completed
    // workspace operation's success/failure semantics.
  }
}

export async function applyTaskWorkspace(
  runId: string,
  selection: PatchSelection[] = [],
  allowIrreversible = false
): Promise<ApplyOutcome> {
  const outcome = await transport.call<ApplyOutcome>("task_workspace_apply", {
    runId,
    selection,
    allowIrreversible,
  })
  if (outcome.state === "applied") await projectAdoptionOutcome(runId, "apply")
  return outcome
}

export async function undoTaskWorkspace(runId: string): Promise<ApplyOutcome> {
  const outcome = await transport.call<ApplyOutcome>("task_workspace_undo", { runId })
  if (outcome.state === "reverted") await projectAdoptionOutcome(runId, "undo")
  return outcome
}

export async function resolveTaskWorkspaceConflict(
  runId: string,
  resolution: "retryMerge" | "applyTask" | "keepCurrent",
  selection: PatchSelection[] = [],
  allowIrreversible = false
): Promise<ApplyOutcome> {
  const outcome = await transport.call<ApplyOutcome>("task_workspace_resolve_conflict", {
    runId,
    resolution,
    selection,
    allowIrreversible,
  })
  if (outcome.state === "applied" || outcome.state === "reverted") {
    await projectAdoptionOutcome(runId, resolution === "keepCurrent" ? "keepCurrent" : "apply")
  }
  return outcome
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength)
  digestInput.set(bytes)
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export async function downloadTaskResource(
  runId: string,
  relPath: string,
  allowSensitive = false
): Promise<Blob> {
  const handle = await transport.call<DownloadHandle>("task_resource_download_open", {
    runId,
    relPath,
    allowSensitive,
  })
  const chunks: Uint8Array[] = []
  let offset = 0
  try {
    while (offset < handle.size) {
      const chunk = await transport.call<TransferChunk>("task_resource_download_read_chunk", {
        handleId: handle.handleId,
        offset,
      })
      const bytes = decodeBase64(chunk.dataBase64)
      if (bytes.byteLength !== chunk.length || (await sha256Hex(bytes)) !== chunk.chunkHash) {
        throw new Error("task resource chunk integrity check failed")
      }
      chunks.push(bytes)
      offset = chunk.nextOffset ?? handle.size
    }
    const body = new Uint8Array(handle.size)
    let cursor = 0
    for (const chunk of chunks) {
      body.set(chunk, cursor)
      cursor += chunk.byteLength
    }
    if ((await sha256Hex(body)) !== handle.hash) {
      throw new Error("task resource integrity check failed")
    }
    return new Blob([body], { type: handle.mediaType })
  } finally {
    await transport
      .call("task_resource_download_close", { handleId: handle.handleId })
      .catch(() => undefined)
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function uploadTaskResource(
  runId: string,
  relPath: string,
  file: Blob,
  allowSensitive = false
): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const expectedHash = await sha256Hex(bytes)
  const handle = await transport.call<UploadHandle>("task_resource_upload_open", {
    runId,
    relPath,
    expectedSize: bytes.byteLength,
    expectedHash,
    allowSensitive,
  })
  try {
    let offset = handle.nextOffset
    while (offset < bytes.byteLength) {
      const chunk = bytes.slice(offset, offset + handle.chunkBytes)
      offset = await transport.call<number>("task_resource_upload_write_chunk", {
        handleId: handle.handleId,
        offset,
        dataBase64: encodeBase64(chunk),
        chunkHash: await sha256Hex(chunk),
      })
    }
    return await transport.call<string>("task_resource_upload_commit", {
      handleId: handle.handleId,
    })
  } catch (error) {
    await transport
      .call("task_resource_upload_abort", { handleId: handle.handleId })
      .catch(() => undefined)
    throw error
  }
}
