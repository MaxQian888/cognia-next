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
 * Disambiguation (verified): the renderer `dispatch_agent` path runs out-of-band
 * and never emits a `task_*` frame nor a `parent_tool_use_id` child, so this
 * bridge can never double-handle it. Pure + best-effort (never throws).
 */

import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgent, SubAgentStatus } from "@/types/agent/sub-agent"
import type {
  SDKMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKTaskUpdatedMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  BetaContentBlock,
} from "@/lib/claude/types"

/**
 * Indeterminate progress from the tool-call count a run has made — a subagent
 * has no real completion percentage, so this rises monotonically and is capped
 * below 100 (only task_updated→completed reaches 100). Mirrors Gap 1's
 * `dispatchProgressForToolCount` so both surfaces feel identical.
 */
function progressForToolUses(toolUses: number): number {
  return Math.min(95, Math.max(0, toolUses) * 10)
}

/** tool_use_id (the spawning Task tool_use) → task_id (our node key). */
const toolUseToTask = new Map<string, string>()

/** Test seam — clears the cross-frame correlation map. */
export function __resetSdkSubagentBridge(): void {
  toolUseToTask.clear()
}

function baseNode(taskId: string, sessionId: string, name: string, task: string): SubAgent {
  const now = new Date()
  return {
    id: taskId,
    parentAgentId: sessionId,
    name,
    description: name,
    task,
    initialTask: task,
    threadId: taskId,
    status: "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 0,
    createdAt: now,
    lastActivityAt: now,
    startedAt: now,
    retryCount: 0,
    order: 0,
    depth: 1,
    context: { parentAgentId: sessionId, sessionId, startTime: now, currentStep: 0 },
  } as SubAgent
}

function mapStatus(s: string | undefined): SubAgentStatus | undefined {
  switch (s) {
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    case "killed":
      return "cancelled"
    default:
      return undefined
  }
}

function onTaskStarted(m: SDKTaskStartedMessage, sessionId: string): void {
  // Only genuine Task-tool subagents (skip ambient / local_workflow housekeeping).
  if (!m.subagent_type || m.skip_transcript || m.task_type === "local_workflow") return
  const store = useSubagentRuntimeStore.getState()
  if (store.subAgents[m.task_id]) return
  if (m.tool_use_id) toolUseToTask.set(m.tool_use_id, m.task_id)
  store.upsert(baseNode(m.task_id, sessionId, m.subagent_type, m.prompt ?? m.description ?? ""))
}

function onTaskProgress(m: SDKTaskProgressMessage): void {
  const store = useSubagentRuntimeStore.getState()
  if (!store.subAgents[m.task_id]) return
  if (m.last_tool_name) {
    store.appendLog(m.task_id, {
      timestamp: new Date(),
      level: "info",
      message: `Running ${m.last_tool_name}`,
    })
  }
  if (m.usage) store.setProgress(m.task_id, progressForToolUses(m.usage.tool_uses))
}

function onTaskUpdated(m: SDKTaskUpdatedMessage): void {
  const store = useSubagentRuntimeStore.getState()
  const sa = store.subAgents[m.task_id]
  if (!sa) return
  const status = mapStatus(m.patch?.status)
  if (!status) return
  store.upsert({
    ...sa,
    status,
    progress: status === "completed" ? 100 : sa.progress,
    completedAt: new Date(),
    lastActivityAt: new Date(),
    ...(m.patch?.error ? { error: m.patch.error } : {}),
  })
}

function onChildFrame(evt: SDKAssistantMessage | SDKUserMessage): void {
  const parentId = evt.parent_tool_use_id
  if (!parentId) return
  const taskId = toolUseToTask.get(parentId)
  if (!taskId) return
  const store = useSubagentRuntimeStore.getState()
  if (!store.subAgents[taskId]) return
  const content = (evt as SDKAssistantMessage).message?.content
  if (!Array.isArray(content)) return
  for (const block of content as BetaContentBlock[]) {
    const b = block as {
      type?: string
      text?: string
      name?: string
      input?: unknown
      content?: unknown
      is_error?: boolean
    }
    if (b.type === "text" && typeof b.text === "string" && b.text) {
      store.pushStreamText(taskId, b.text)
    } else if (b.type === "tool_use" && b.name) {
      store.appendLog(taskId, {
        timestamp: new Date(),
        level: "info",
        message: b.name,
        data: b.input,
      })
    } else if (b.type === "tool_result") {
      store.appendLog(taskId, {
        timestamp: new Date(),
        level: b.is_error ? "error" : "info",
        message: "tool_result",
        data: b.content,
      })
    }
  }
}

/**
 * Fold one raw SDK message into the subagent runtime store. Call once per
 * `claude://message` event for every session kind. No-op for non-subagent
 * frames; never throws.
 */
export function applySdkSubagentBridge(evt: SDKMessage, sessionId: string): void {
  try {
    if (!evt || typeof evt !== "object") return
    if (evt.type === "system") {
      const sub = (evt as { subtype?: string }).subtype
      if (sub === "task_started") onTaskStarted(evt as SDKTaskStartedMessage, sessionId)
      else if (sub === "task_progress") onTaskProgress(evt as SDKTaskProgressMessage)
      else if (sub === "task_updated") onTaskUpdated(evt as SDKTaskUpdatedMessage)
      return
    }
    if (evt.type === "assistant" || evt.type === "user") {
      onChildFrame(evt as SDKAssistantMessage | SDKUserMessage)
    }
  } catch {
    // Best-effort: a bridge throw must never break the chat event loop.
  }
}
