/**
 * Assembles what a live-voice session needs from the rest of the app: the tool
 * manifest, the tool executor, the permission policy, and the conversation
 * seed.
 *
 * This exists as its own module so the dialog stays a view. Everything here is
 * resolved **once**, at session start:
 *
 * - Re-resolving tools mid-session is a protocol-level session change most
 *   providers handle badly, and the model has already been told what exists.
 * - Re-reading permissions mid-session would let a settings edit change the
 *   rules under a call the user is already looking at.
 *
 * Tools come from `buildPluginToolsManifest()` rather than `resolveSendOptions()`.
 * The manifest is exactly the `pluginTools` field `resolveSendOptions` would
 * return, minus the twin RAG and memory-recall passes that a voice session has
 * no use for and that the plan explicitly did not want re-run per session.
 */

import type { Experimental_RealtimeModelV4ToolDefinition as RealtimeToolDefinition } from "@ai-sdk/provider"
import type { UIMessage } from "ai"

import type { RealtimeToolPolicy } from "./approval"
import { buildLiveVoiceContext, type LiveVoiceContextLimits } from "./context"
import { mapRealtimeTools, type DroppedTool, type PluginToolEntry } from "./tools"
import type { RealtimeToolExecutionRequest, RealtimeToolExecutionResult } from "./tool-runtime"
import type { LiveVoiceCapabilities } from "./types"

export interface LiveVoiceRuntimeDeps {
  listMessages(sessionId: string): Promise<UIMessage[]>
  buildPluginToolsManifest(): Promise<PluginToolEntry[]>
  executeTool(request: RealtimeToolExecutionRequest): Promise<RealtimeToolExecutionResult>
}

export interface BuildLiveVoiceRuntimeOptions {
  /** Chat session to seed from and to attribute approvals to. */
  sessionId?: string
  capabilities: LiveVoiceCapabilities
  policy: RealtimeToolPolicy
  limits: LiveVoiceContextLimits
  deps?: Partial<LiveVoiceRuntimeDeps>
}

export interface LiveVoiceRuntimeBindings {
  tools?: RealtimeToolDefinition[]
  toolExecution?: {
    sessionId: string
    policy: RealtimeToolPolicy
    execute(request: RealtimeToolExecutionRequest): Promise<RealtimeToolExecutionResult>
  }
  contextTranscript?: string
  /** Tools the manifest offered that could not be advertised, for diagnostics. */
  droppedTools: DroppedTool[]
}

// These names are routed around invokePluginTool by plugin-tool-ipc. Their
// host runners do not share one cancellation contract, so advertising them in
// a Gemini session would let toolCallCancellation report success while a
// dialog/task/terminal side effect kept running. Regular plugin tools receive
// AbortSignal through PluginToolContext and remain eligible.
const NON_CANCELLABLE_LIVE_VOICE_TOOLS = new Set([
  "ask_user",
  "web_search",
  "web_fetch",
  "read_active_editor",
  "spawn_task",
  "list_sessions",
  "send_session_message",
  "vector_search",
  "vector_add_document",
  "vector_delete_document",
  "Skill",
  "load_skill",
  "load_skill_resource",
  "SlashCommand",
  "wf_run_workflow_typed",
  "dispatch_agent",
  "Task",
  "team_send_message",
  "team_publish_memory",
  "team_read_memory",
  "team_request_consensus",
  "team_vote",
  "team_delegate",
  "team_list_members",
  "task_add_comment",
  "task_get",
  "twin_knowledge_search",
  "team_post_to_chat",
  "team_propose_decision",
])

function liveVoiceToolIsCancellable(entry: PluginToolEntry): boolean {
  return (
    !NON_CANCELLABLE_LIVE_VOICE_TOOLS.has(entry.name) && !entry.name.startsWith("terminal_dock_")
  )
}

/** Lazy defaults — none of these are reachable from a node-env test. */
const defaultDeps: LiveVoiceRuntimeDeps = {
  listMessages: async (sessionId) => {
    const { listMessages } = await import("@/lib/db/messages")
    return listMessages(sessionId)
  },
  buildPluginToolsManifest: async () => {
    const { buildPluginToolsManifest } = await import("@/lib/plugin/bridge/sidecar-tools-bridge")
    return buildPluginToolsManifest()
  },
  executeTool: async (request) => {
    const { handlePluginToolExec } = await import("@/lib/claude/plugin-tool-ipc")
    const response = await handlePluginToolExec({
      type: "plugin_tool_exec",
      sessionId: request.sessionId,
      toolUseId: request.callId,
      name: request.name,
      args: request.args,
      abortSignal: request.signal,
    })
    return { result: response.result, error: response.error }
  },
}

/**
 * Resolve everything the controller needs beyond the socket itself.
 *
 * Failures are absorbed: a session that cannot read its history or its plugin
 * manifest is still a usable voice session, just without context or tools.
 * Refusing to start would be a worse trade.
 */
export async function buildLiveVoiceRuntimeBindings(
  options: BuildLiveVoiceRuntimeOptions
): Promise<LiveVoiceRuntimeBindings> {
  const deps = { ...defaultDeps, ...options.deps }
  const bindings: LiveVoiceRuntimeBindings = { droppedTools: [] }

  // ── Tools ────────────────────────────────────────────────────────────
  // A provider whose tool support is dormant gets none, and without a chat
  // session there is nowhere to attribute an approval card to.
  if (options.capabilities.supportsTools && options.sessionId) {
    try {
      const manifest = await deps.buildPluginToolsManifest()
      const cancellable = manifest.filter(liveVoiceToolIsCancellable)
      const mapping = mapRealtimeTools(cancellable)
      bindings.droppedTools = mapping.dropped
      if (mapping.tools.length > 0) {
        bindings.tools = mapping.tools
        bindings.toolExecution = {
          sessionId: options.sessionId,
          policy: options.policy,
          execute: deps.executeTool,
        }
      }
    } catch {
      // Plugin store unavailable — carry on without tools.
    }
  }

  // ── Conversation seed ────────────────────────────────────────────────
  if (options.sessionId) {
    try {
      const history = await deps.listMessages(options.sessionId)
      const transcript = buildLiveVoiceContext(history, options.limits)
      if (transcript) bindings.contextTranscript = transcript
    } catch {
      // History unreadable — start cold rather than not at all.
    }
  }

  return bindings
}
