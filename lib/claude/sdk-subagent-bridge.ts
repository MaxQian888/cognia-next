/**
 * Gap 2 bridge: translate SDK-native subagent activity (the `opts.agents` /
 * Task-tool path used by team + workflow-editor sessions) into
 * `subagent-runtime-store` updates so they render in the same chat
 * `SubagentTree` as renderer-side `dispatch_agent` runs.
 *
 * Lifecycle is driven by the SDK's authoritative `system/task_started`,
 * `task_progress`, `task_updated` frames (keyed by `task_id`). Rich per-step
 * logs come from assistant/user frames whose `parent_tool_use_id` maps back to
 * a known task (only present when `forwardSubagentText` is enabled).
 *
 * Nesting uses the SDK's `parent_task_id` when present. Older producers fall
 * back to local correlation — every `tool_use` block streamed inside a
 * task's forwarded child frames is recorded as owned by that task, and a later
 * `task_started` whose `tool_use_id` matches an owned block hangs off that
 * owner as a depth-N child (`parentSubagentId` edge, rendered by the same
 * `SubagentTree` the dispatch_agent engine feeds). Tasks spawned by the
 * top-level chat correlate to no owner and stay depth 1.
 *
 * Disambiguation (verified): the renderer `dispatch_agent` path runs out-of-band
 * and never emits a `task_*` frame nor a `parent_tool_use_id` child, so this
 * bridge can never double-handle it. Pure + best-effort (never throws).
 */

import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgent, SubAgentStatus } from "@/types/agent/sub-agent"
import { createSubAgentNode } from "@/lib/claude/subagent-projection"
import {
  registerSubagentCancellation,
  unregisterSubagentRun,
} from "@/lib/claude/agents/subagent-cancel-registry"
import type {
  SDKMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKTaskUpdatedMessage,
  SDKTaskNotificationMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  BetaContentBlock,
} from "@cognia/agent-config-types"

/** tool_use_id (the spawning Task tool_use) → task_id (our node key). */
const toolUseToTask = new Map<string, { taskId: string; runId?: string }>()

/**
 * tool_use block id → the task whose forwarded child frame CONTAINED it.
 * This is the fallback nesting correlator for older SDK producers. When a subagent itself
 * spawns a Task, the spawning `tool_use` block streams inside one of ITS
 * forwarded child frames — so the block's owner IS the nested task's parent.
 * Blocks owned by the top-level chat never enter this map (top-level frames
 * have no `parent_tool_use_id`), so a depth-1 task correlates to no parent.
 */
const toolUseOwner = new Map<string, string>()
/** A resumed task keeps its task id but gets a lexically newer run id. */
const taskRuns = new Map<string, string>()
const cancellableTaskIds = new Set<string>()

export interface SdkSubagentControls {
  stopTask(taskId: string): Promise<void>
}

/** Test seam — clears the cross-frame correlation maps. */
export function __resetSdkSubagentBridge(): void {
  toolUseToTask.clear()
  toolUseOwner.clear()
  taskRuns.clear()
  for (const taskId of cancellableTaskIds) unregisterSubagentRun(taskId)
  cancellableTaskIds.clear()
}

function baseNode(
  taskId: string,
  sessionId: string,
  name: string,
  task: string,
  parent?: SubAgent
): SubAgent {
  // Depth 1 under the spawning chat session, unless the spawning tool_use was
  // seen inside another task's forwarded child frames — then this is a nested
  // task and the node hangs off that parent (depth-N, same tree model the
  // dispatch_agent engine uses; `SubagentTree` renders both identically).
  return createSubAgentNode({
    id: taskId,
    name,
    task,
    parentAgentId: parent ? parent.id : sessionId,
    depth: parent ? (parent.depth ?? 1) + 1 : 1,
    ...(parent ? { parentSubagentId: parent.id } : {}),
    sessionId,
  })
}

function mapStatus(s: string | undefined): SubAgentStatus | undefined {
  switch (s) {
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    case "killed":
    case "stopped":
      return "cancelled"
    default:
      return undefined
  }
}

function onTaskStarted(
  m: SDKTaskStartedMessage,
  sessionId: string,
  controls?: SdkSubagentControls
): void {
  // Only genuine Task-tool subagents (skip ambient / local_workflow housekeeping).
  if (!m.subagent_type || m.skip_transcript || m.task_type === "local_workflow") return
  const store = useSubagentRuntimeStore.getState()
  const existing = store.subAgents[m.task_id]
  if (existing && existing.context?.sessionId !== sessionId) return
  const previousRun = taskRuns.get(m.task_id)
  if (m.run_id && previousRun && m.run_id < previousRun) return
  if (existing && (!m.run_id || m.run_id === previousRun)) return
  if (m.run_id) taskRuns.set(m.task_id, m.run_id)
  if (m.tool_use_id) toolUseToTask.set(m.tool_use_id, { taskId: m.task_id, runId: m.run_id })
  const parentTaskId =
    m.parent_task_id ?? (m.tool_use_id ? toolUseOwner.get(m.tool_use_id) : undefined)
  const candidate = parentTaskId ? store.subAgents[parentTaskId] : undefined
  const parent = candidate?.context?.sessionId === sessionId ? candidate : undefined
  store.upsert(
    baseNode(m.task_id, sessionId, m.subagent_type, m.prompt ?? m.description ?? "", parent)
  )
  if (controls) {
    registerSubagentCancellation(m.task_id, () => controls.stopTask(m.task_id))
    cancellableTaskIds.add(m.task_id)
  }
}

function onTaskProgress(m: SDKTaskProgressMessage, sessionId: string): void {
  const store = useSubagentRuntimeStore.getState()
  if (!isCurrentRun(m, sessionId)) return
  if (m.last_tool_name) {
    store.appendLog(m.task_id, {
      timestamp: new Date(),
      level: "info",
      message: `Running ${m.last_tool_name}`,
    })
  }
  if (m.usage) {
    // gap9: surface the honest raw tool-use count only. The old derived
    // pseudo-percentage (`setProgress`) is gone — no surface renders a
    // completion bar for a subagent run anymore.
    store.setToolUses(m.task_id, m.usage.tool_uses)
  }
}

function isCurrentRun(m: { task_id: string; run_id?: string }, sessionId: string): boolean {
  const node = useSubagentRuntimeStore.getState().subAgents[m.task_id]
  const runId = taskRuns.get(m.task_id)
  return node?.context?.sessionId === sessionId && (!m.run_id || !runId || m.run_id === runId)
}

function onTaskUpdated(
  m: SDKTaskUpdatedMessage | SDKTaskNotificationMessage,
  sessionId: string
): void {
  const store = useSubagentRuntimeStore.getState()
  const sa = store.subAgents[m.task_id]
  if (!sa || !isCurrentRun(m, sessionId)) return
  const status = mapStatus(m.subtype === "task_notification" ? m.status : m.patch?.status)
  if (!status) return
  unregisterSubagentRun(m.task_id)
  cancellableTaskIds.delete(m.task_id)
  store.upsert({
    ...sa,
    status,
    progress: status === "completed" ? 100 : sa.progress,
    completedAt: new Date(),
    lastActivityAt: new Date(),
    ...(m.subtype === "task_updated" && m.patch?.error ? { error: m.patch.error } : {}),
  })
}

function onChildFrame(evt: SDKAssistantMessage | SDKUserMessage, sessionId: string): void {
  const parentId = evt.parent_tool_use_id
  const correlation = parentId ? toolUseToTask.get(parentId) : undefined
  const taskId = evt.agent_id ?? correlation?.taskId
  if (!taskId) return
  if (correlation?.runId && correlation.runId !== taskRuns.get(taskId)) return
  const store = useSubagentRuntimeStore.getState()
  if (store.subAgents[taskId]?.context?.sessionId !== sessionId) return
  const content = (evt as SDKAssistantMessage).message?.content
  if (!Array.isArray(content)) return
  for (const block of content as BetaContentBlock[]) {
    const b = block as {
      type?: string
      text?: string
      id?: string
      tool_use_id?: string
      name?: string
      input?: unknown
      content?: unknown
      is_error?: boolean
    }
    if (b.type === "text" && typeof b.text === "string" && b.text) {
      store.pushStreamText(taskId, b.text)
    } else if (b.type === "tool_use" && b.name) {
      // Record the block's owner so a nested `task_started` naming this
      // tool_use id can resolve its parent task (see `toolUseOwner`).
      if (typeof b.id === "string" && b.id) toolUseOwner.set(b.id, taskId)
      // Log + populate the inline tool list (toolCalls) in one write so the
      // SDK-native Task engine matches the dispatch_agent engine.
      store.applyRunEvent(taskId, {
        log: { timestamp: new Date(), level: "info", message: b.name, data: b.input },
        toolStart: {
          id: b.id ?? `${taskId}:${b.name}`,
          name: b.name,
          ...(b.input && typeof b.input === "object"
            ? { input: b.input as Record<string, unknown> }
            : {}),
        },
      })
    } else if (b.type === "tool_result") {
      store.applyRunEvent(taskId, {
        log: {
          timestamp: new Date(),
          level: b.is_error ? "error" : "info",
          message: "tool_result",
          data: b.content,
        },
        ...(b.tool_use_id
          ? { toolEnd: { id: b.tool_use_id, output: b.content, isError: b.is_error } }
          : {}),
      })
    }
  }
}

/**
 * Fold one raw SDK message into the subagent runtime store. Call once per
 * `claude://message` event for every session kind. No-op for non-subagent
 * frames; never throws.
 */
export function applySdkSubagentBridge(
  evt: SDKMessage,
  sessionId: string,
  controls?: SdkSubagentControls
): void {
  try {
    if (!evt || typeof evt !== "object") return
    if (evt.type === "system") {
      const sub = (evt as { subtype?: string }).subtype
      if (sub === "task_started") onTaskStarted(evt as SDKTaskStartedMessage, sessionId, controls)
      else if (sub === "task_progress") onTaskProgress(evt as SDKTaskProgressMessage, sessionId)
      else if (sub === "task_updated") onTaskUpdated(evt as SDKTaskUpdatedMessage, sessionId)
      else if (sub === "task_notification")
        onTaskUpdated(evt as SDKTaskNotificationMessage, sessionId)
      return
    }
    if (evt.type === "assistant" || evt.type === "user") {
      onChildFrame(evt as SDKAssistantMessage | SDKUserMessage, sessionId)
    }
  } catch {
    // Best-effort: a bridge throw must never break the chat event loop.
  }
}
