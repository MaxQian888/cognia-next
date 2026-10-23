import {
  sdkOptionsForStorage,
  sdkSessionStorageFromOptions,
  type SdkSessionStorage,
} from "@/lib/claude/claude-sdk-rollout"
/**
 * Persistent multi-turn agent session — the core behind the interactive TUI.
 *
 * Unlike `runHeadlessTurn` (bootstrap → one turn → shutdown), this bootstraps
 * the sidecar ONCE and keeps it alive, so every `send()` reuses the same
 * `sessionId`. The sidecar keeps that SDK session open (it `pushUserMessage`s
 * follow-ups), so context accumulates in-process across turns — exactly the
 * desktop chat behaviour, reused unchanged.
 *
 * Collaborators are injected so the multi-turn orchestration unit-tests without
 * a live sidecar or model.
 */

import os from "node:os"

import { type BuildOptionsContext } from "@/lib/claude/build-options"
import {
  runAndCaptureAssistantReply as defaultCapture,
  RunAndCaptureError,
  type RunAndCapturePartial,
  type RunAndCaptureResult,
  type CaptureStreamEvent,
} from "@/lib/claude/run-and-capture"
import { setSessionMode as defaultSetSessionMode } from "@/lib/claude/ipc"
import type { SendOptions } from "@cognia/agent-config-types"
import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"

/** A concrete permission mode value (excludes `undefined`). */
type PermissionModeValue = NonNullable<SendOptions["permissionMode"]>

import type { McpServer } from "@cognia/agent-config-types"

import { type BuiltAttachmentContent } from "./attachments/build"
import { resolveHome } from "../config/load"
import { type ResolvedConfig, type ThinkingLevel } from "../config/schema"
import type { EffortTier } from "@/lib/ai/thinking-level"
import type { TuiAction } from "../tui/state/types"
import { loadMcpServers } from "../mcp/load-mcp-config"
import { applyDisabled, readDisabled, readDisabledTools } from "../mcp/mcp-state"
import { bootstrapSidecar, type SidecarBootstrap } from "../runtime/bootstrap"
import { CliDbSnapshotError } from "../db/bootstrap"
import { subscribePluginToolDispatch } from "../plugin/plugin-tool-dispatch"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { mintSessionId } from "./run"
import { type PermissionResponder } from "./permission-gate"
import { fetchTwinContext as defaultFetchTwinContext } from "../twin/context-client"
import { approvalKey } from "./command-approval"
import { readToolApprovals } from "./tool-approvals"
import {
  appendTranscript,
  readTranscriptTail,
  type TranscriptFs,
  type TranscriptTail,
} from "./transcript"
import {
  CLI_AUTO_APPROVED_TOOLS,
  withCliAutoApprovedTools,
  withCliDisabledMcpTools,
} from "./tool-suppression"
import { type AgentSummary } from "./discover-agents"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import { clearCliSubagentContext } from "./subagent-dispatch"
import { makeConfiguredCliPluginToolHandle } from "./configured-plugin-tool-handle"
import { bindCliSessionHostRuntime } from "./cli-host-runtime"
import {
  registerCliSkillLoadContext,
  releaseCliSkillLoadContext,
  type LoadableSkill,
} from "./skill-load-tool"
import {
  createCliContextAssembler,
  prependTextBlock,
  twinContextBlock,
  type AttachmentSummary,
  type CliContextAssembler,
  type ResolvedCliSessionContext,
} from "./session-context"
import { registerTurnSubagentContext } from "./turn-dispatch"
import { createEnvelopeEmitter } from "./runtime/turn-events"
import {
  clearToolHostStatus,
  publishBuiltinToolHostStatus,
  observeBuiltinToolResult,
  type ToolHostSnapshot,
} from "./tool-host/status"

export class AgentSessionStartupError extends Error {
  readonly code = "plugin_relay_unavailable"
  readonly retryable = true

  constructor(cause: unknown) {
    super("Plugin tool relay failed to start. Retry the turn to reconnect the tool host.", {
      cause,
    })
    this.name = "AgentSessionStartupError"
  }
}

export type { AttachmentSummary }

// Re-exported from `./tool-suppression` so existing
// `import { … } from "./session-runner"` call sites (and tests) stay unchanged.
export { CLI_AUTO_APPROVED_TOOLS, withCliAutoApprovedTools, withCliDisabledMcpTools }

export interface AgentSessionParams {
  config: ResolvedConfig
  sessionId?: string
  /**
   * Session kind forwarded to `toBuildContext`. Defaults to `"direct"`. Set to
   * `"workflow-editor"` (with a `sessionId` shaped `workflow:<id>`) to run the
   * desktop Workflow Copilot agent — `resolveSendOptions` then swaps the prompt
   * + `wf_*` tool whitelist and injects the live editor-store snapshot.
   */
  sessionKind?: import("@cognia/agent-config-types").SessionKind
  home?: string
  bootstrap?: (cwd: string) => Promise<SidecarBootstrap>
  resolveOptions?: (ctx: BuildOptionsContext) => Promise<SendOptions>
  /** Definition-owned composition selection, forwarded to the shared resolver. */
  compositionSelection?: AgentCompositionSelectionV1
  /** Definition-owned JSON Schema, lowered onto the native SDK output format. */
  outputSchema?: Record<string, unknown>
  /**
   * Have the sidecar snapshot each mutating tool call's target files before
   * the call runs (`file_pre_mutation` frames), for a host that rewinds files.
   */
  fileCheckpoints?: boolean
  /** Resolve one CLI-dispatched child with actor-specific transport overrides. */
  resolveSubagentOptions?: (actorRef: string, ctx: BuildOptionsContext) => Promise<SendOptions>
  /** Provide an actor-scoped permission script for one CLI-dispatched child. */
  resolveSubagentGate?: (actorRef: string) => PermissionResponder
  capture?: typeof defaultCapture
  transcriptFs?: TranscriptFs
  /** Assemble multimodal content from a typed prompt — encode `@image` refs,
   * inject text/rich-doc content, and resolve `@*.pdf` per the active model.
   * Defaults to {@link buildAttachmentContent}; injected in tests. */
  buildContent?: (
    prompt: string,
    cwd: string
  ) => BuiltAttachmentContent | Promise<BuiltAttachmentContent>
  /** Resolve the MCP servers to expose. Defaults to loading `.mcp.json` from
   * the cwd + home, applying the `/mcp disable` overlay. */
  resolveMcpServers?: () => McpServer[]
  /** Resolve the session-enabled skill ids. Defaults to the `/skill` state file. */
  resolveSkillIds?: () => string[]
  /** Resolve metadata (id/name/description) for the enabled skills, to build the
   * `load_skill` tool's catalog when `skillLoadMode === "name"`. Defaults to a
   * CLI-local Dexie read; injected in tests. Best-effort — a failure yields a
   * generic (still functional) tool. */
  resolveLoadableSkills?: (ids: string[]) => Promise<LoadableSkill[]>
  /** Resolve the per-tool MCP disable overlay (namespaced `mcp__server__tool`
   * names) to union into `disallowedTools`. Defaults to the `mcp-state.json`
   * store; injected in tests. */
  resolveDisabledMcpTools?: () => Set<string>
  /** Open the CLI-local Dexie (installs the `window` + IndexedDB shims that
   * `getDb()` requires) before resolving options. Only invoked when at least
   * one skill is enabled, since that is the lone build-options read the CLI's
   * `toBuildContext` can route through Dexie. Defaults to {@link ensureCliDb};
   * injected in tests. */
  ensureDb?: () => Promise<unknown>
  /** Prompt Center bootstrap; separate from skill DB initialization in tests. */
  primePromptOverrides?: Parameters<typeof createCliContextAssembler>[0]["primePromptOverrides"]
  /** Resolve the user's persisted "Allow always" tool names. Defaults to the
   * `tool-approvals.json` store; injected in tests. */
  resolveApprovedTools?: () => Set<string>
  /** Bootstrap the in-tree plugin runtime (only when `config.pluginTools`).
   * Defaults to {@link ensurePluginRuntime}; injected as a no-op in tests. */
  loadPluginRuntime?: () => Promise<unknown>
  /** Subscribe the `plugin_tool_exec` executor after the sidecar is live (when
   * plugin/web tools are on, or subagents are available so the `dispatch_agent`
   * tool can resolve). Defaults to {@link subscribePluginToolDispatch} with the
   * CLI subagent-aware handle. */
  subscribePluginTools?: () => Promise<UnlistenFn>
  /** Discover the dispatchable `.cognia/agents/*.md` subagents for this session.
   * Seeds the `dispatch_agent` (Task) tool the model uses to launch a subagent
   * on the non-Anthropic (ai-sdk) channel — that channel has no SDK-native Task
   * tool, so without this the model cannot delegate. Defaults to scanning the
   * cwd + home roots; injected in tests. */
  resolveAgents?: () => Promise<AgentSummary[]>
  /** Resolve the active agent mode (built-in or `.cognia/modes/*.json` custom)
   * for this session. The resolved {@link AgentModeConfig} is threaded into
   * `toBuildContext` so the shared `resolveSendOptions` applies its system-prompt
   * append, tool allow-list, model override, and permission ruleset — exactly as
   * the desktop does. Defaults to resolving `config.agentMode` against the modes
   * discovered under the cwd + home roots; injected in tests. */
  resolveAgentMode?: () => Promise<AgentModeConfig | null>
  /** Send the `claude_set_mode` control message to mutate the LIVE session's
   * permission mode without respawning the sidecar. Defaults to the ipc
   * {@link defaultSetSessionMode}; injected in tests. */
  setSessionMode?: (sessionId: string, mode: PermissionModeValue) => Promise<void>
  /** Fetch the twin context from the running desktop (only when `config.twin`
   * is enabled). Resolves `null` on any failure — the turn then proceeds
   * without twin grounding. Injected in tests. */
  fetchTwin?: typeof defaultFetchTwinContext
  now?: () => number
  /** Receives the exact execution spec resolved for this live session. */
  onResolvedExecutionSpec?: (spec: ResolvedAgentExecutionSpec) => void
  onToolHostStatus?: (snapshot: ToolHostSnapshot) => void
}

/** A model option exposed by the external agent that is currently hosting a session. */
export interface AgentModelOption {
  id: string
  name?: string
}

export interface SendTurnOptions {
  gate: PermissionResponder
  /**
   * Resolve once no approval is awaiting the user.
   *
   * Held by the tool host before it authorizes anything, so a call that needs
   * no approval does not run while the user is answering a question about a
   * different one. Optional: a caller with no approval UI has no barrier to
   * wait on.
   */
  awaitApprovals?: () => Promise<void>
  /** Preferred canonical stream. When present, the session does not invoke
   * `onEvent`, preventing the same event from being applied twice. */
  onEnvelope?: (envelope: AgentEventEnvelope) => void
  onEvent?: (event: CaptureStreamEvent) => void
  /** Direct reducer actions for sessions whose native event vocabulary is
   * richer than CaptureStreamEvent (external ACP/Codex agents). */
  onAction?: (action: TuiAction) => void
  /** Fired once per session, on the first turn that loads session-enabled
   * skills, with the skill ids that resolved into the prompt. Lets the UI show
   * the user which skills are active. Not fired for plain (skill-less) chat. */
  onActiveSkills?: (skillIds: string[]) => void
  /** Fired once per turn when the prompt referenced one or more `@<path>`
   * attachments, summarising how each was handled. Lets the UI show a notice. */
  onAttachments?: (summary: AttachmentSummary) => void
  /** Fired at most once per session when twin grounding is enabled but the
   * desktop bridge is unreachable — the turn proceeds without twin context. */
  onTwinNotice?: (message: string) => void
  /** Fired once, on the first turn after a resume that left earlier requests
   * out of the model's context (their turn failed before saving a reply). */
  onRestoreNotice?: (message: string) => void
  /** Fired at most once per session when the CLI-local db could not be opened
   * because its snapshot was corrupt or schema-incompatible. The snapshot has
   * been moved aside (see {@link CliDbSnapshotError.preservedPath}) and the turn
   * proceeds without skills. Unlike a transient open failure this MUST reach the
   * user: their sessions/goals/memory are intact on disk, but nothing else says
   * so, and an unannounced empty db reads as silent data loss. */
  onDatabaseError?: (error: CliDbSnapshotError) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export type AgentSessionUiEvent =
  | Extract<
      import("@cognia/agent-config-types/agent-execution").CanonicalAgentEvent,
      { kind: "extension-ui" }
    >
  | { kind: "input-queue-cleared"; text: string; imagePaths: string[] }

export interface AgentSession {
  /** Canonical autonomous turns emitted outside send(), with normal transcript semantics. */
  subscribeEvents?(listener: (event: AgentEventEnvelope) => void): () => void
  cancel?(): Promise<void>
  /** Ephemeral UI requests emitted outside a send turn. */
  subscribeUiEvents?(listener: (event: AgentSessionUiEvent) => void): () => void
  readonly sessionId: string
  send(prompt: string, opts: SendTurnOptions): Promise<RunAndCaptureResult>
  /** Prepare the shared transport for a manual child, without a parent model turn. */
  prepareForSubagent?(): Promise<void>
  /** Drop the cached SendOptions so the next `send` re-resolves them — used
   * after `/mcp`, `/skill`, or `/plugin` toggle a server/skill mid-session.
   * Optional so lightweight test doubles need not implement it. */
  invalidateOptions?(): void
  /** Mutate the live session's permission mode in place (no respawn), so the
   * in-process conversation is preserved across a Shift+Tab / plan-approval
   * mode switch. A no-op before the sidecar has spawned — the mode then folds
   * into the first `startSession`. Optional for lightweight test doubles.
   *
   * Resolves whether the new mode is in force NOW. `false` means the running
   * agent could not be switched and its session has to be recreated for the
   * change to be real (an external agent that bakes its policy in at spawn), so
   * the caller can say so instead of showing a mode that is not being enforced. */
  setPermissionMode?(mode: PermissionModeValue): Promise<boolean>
  /** True once the sidecar has spawned (≥1 `send` happened) — i.e. there is a
   * live session the sidecar knows by `sessionId`, so a manual `/compact` can
   * target it. Optional so lightweight test doubles need not implement it. */
  isLive?(): boolean
  /**
   * Apply a `/model` pick to the live session in place, preserving the thread.
   * Resolves `true` when it landed on a live session, `false` when there was
   * nothing live to switch or the agent has no model selection — the caller
   * then relies on the next turn picking the model up from config. Only the
   * external path implements this; the built-in sidecar bakes the model into
   * resolved SendOptions and recreates the session instead.
   */
  setModel?(model: string): Promise<boolean>
  /** Return model options advertised by the live external session. */
  listModels?(): Promise<AgentModelOption[]>
  /**
   * The thinking levels the live session's model actually publishes, projected
   * onto the app's tier vocabulary. `[]` means the surface was read and the
   * model declares no usable depth axis; `null` means the surface could not be
   * read at all (nothing live on a non-ACP preset, or a read failure), where the
   * caller falls back to the full ladder rather than claiming a model has no
   * control it merely hasn't described yet.
   */
  listThinkingLevels?(): Promise<EffortTier[] | null>
  /**
   * Apply a thinking-level pick to the LIVE session now — on Devin the level IS
   * a model variant, so the write lands as a model switch. Resolves the model
   * id the session reports afterwards, or `undefined` for "off" (forward
   * nothing), an agent with no depth axis, or no live session to write.
   */
  setThinkingLevel?(level: ThinkingLevel): Promise<string | undefined>
  /**
   * Deliver user input into the session's IN-FLIGHT turn (Pi `steer`, Codex
   * `turn/steer`). Throws when nothing is executing or the backend cannot
   * steer — the caller then falls back to queue-and-replay. Optional: the
   * built-in sidecar has no live steer channel and does not implement it.
   */
  steer?(text: string): Promise<void>
  close(): Promise<void>
}

/**
 * Create a persistent agent session. Lazy: the sidecar spawns + context
 * resolves on the first `send`. Subsequent sends reuse both.
 *
 * The session's MEANING (prompt, tools, policy, attachments, twin grounding)
 * comes from the shared {@link createCliContextAssembler}; this module owns only
 * the sidecar transport mapping — spawning it, keeping the plugin-tool executor
 * subscribed, and streaming the turn through `runAndCaptureAssistantReply`.
 */
/**
 * What a restore could not bring back, for the notice the next turn shows.
 * `unfinishedTurns` counts requests after the last completed turn: their turn
 * failed before it saved a provider snapshot, so the model never sees them.
 */
export interface RuntimeHistoryRestore {
  unfinishedTurns: number
  /** True when no turn ever completed, so the model starts without history. */
  startsFresh: boolean
}

/** The notice for a restore that left requests out of the model's context. */
export function runtimeHistoryRestoreNotice(restore: RuntimeHistoryRestore): string | undefined {
  const n = restore.unfinishedTurns
  if (n === 0) return undefined
  const requests = n === 1 ? "1 earlier request" : `${n} earlier requests`
  return restore.startsFresh
    ? `Resumed without model history: ${requests} never finished, so the model has not seen ${n === 1 ? "it" : "them"}. Send ${n === 1 ? "it" : "them"} again if you still need the answer.`
    : `Resumed from the last completed turn: ${requests} after it did not finish and ${n === 1 ? "is" : "are"} not in the model's context. Send ${n === 1 ? "it" : "them"} again if you still need the answer.`
}

/**
 * Validate a saved provider-conversation snapshot: every message has a known
 * role and content, and every tool call is answered exactly once. Returns the
 * messages to seed, or why the snapshot cannot be replayed faithfully.
 */
function checkConversationSnapshot(
  saved: unknown[]
): NonNullable<SendOptions["initialConversation"]> | string {
  const calls = new Set<string>()
  const messages: NonNullable<SendOptions["initialConversation"]> = []
  for (const raw of saved) {
    if (!raw || typeof raw !== "object") return "a saved message is malformed"
    const message = raw as { role?: string; content?: unknown }
    if (
      typeof message.role !== "string" ||
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      !(typeof message.content === "string" || Array.isArray(message.content))
    )
      return "a saved message has an incompatible format"
    messages.push({ ...message, role: message.role })
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!part || typeof part !== "object" || typeof part.type !== "string")
        return "a saved message content part is malformed"
      if (part.type === "tool-call") {
        if (typeof part.toolCallId !== "string" || calls.has(part.toolCallId))
          return "a saved tool call has a missing or duplicate id"
        calls.add(part.toolCallId)
      } else if (part?.type === "tool-result") {
        if (!calls.delete(part.toolCallId)) return "a saved tool result has no matching call"
      }
    }
  }
  if (calls.size) return "the saved turn has unresolved tool calls"
  return messages
}

/** Reject lossy restoration before dispatching a new provider turn. */
function restoreRuntimeHistory(
  options: SendOptions,
  tail: TranscriptTail
): RuntimeHistoryRestore | undefined {
  if (!tail.hasEntries) return undefined
  function fail(reason: string): never {
    throw new Error(
      `Cannot resume this conversation: ${reason}. Start a new session or resume with the original runtime/provider.`
    )
  }
  const latest = tail.latestAssistant
  const saved = latest?.meta?.runtimeHistory as
    | {
        version?: number
        provider?: string
        runtime?: string
        sdkSessionId?: string
        sdkSessionStorage?: SdkSessionStorage
        messages?: unknown[]
      }
    | undefined
  const runtime =
    options.execution?.runtimeAdapter ??
    (options.provider === "anthropic" ? "claude-agent-sdk" : "ai-sdk")
  // Only failed requests so far: nothing durable was ever produced, so there is
  // no history to lose by starting the provider conversation empty.
  if (!latest && tail.lastNonSystemRole === "user")
    return { unfinishedTurns: tail.unfinishedUserTurns, startsFresh: true }
  if (!saved || saved.version !== 1)
    fail("the saved transcript has no compatible durable runtime history")
  if (saved.runtime !== runtime || saved.provider !== options.provider)
    fail("the saved runtime/provider differs from this session")
  if (runtime === "claude-agent-sdk") {
    if (typeof saved.sdkSessionId !== "string" || !saved.sdkSessionId)
      fail("the native SDK session id is missing")
    options.resumeSessionId = saved.sdkSessionId
    if (saved.sdkSessionStorage) {
      if (
        !["filesystem", "host-sqlite"].includes(saved.sdkSessionStorage.backend) ||
        (saved.sdkSessionStorage.workspace != null &&
          typeof saved.sdkSessionStorage.workspace !== "string")
      )
        fail("the SDK storage binding is invalid")
      options.claudeAgentSdk = sdkOptionsForStorage(saved.sdkSessionStorage, options.claudeAgentSdk)
    }
    // The native session keeps its own record of a failed turn, so nothing
    // here can say what it does or does not contain.
    return { unfinishedTurns: 0, startsFresh: false }
  }
  // A turn that failed after the latest snapshot saved nothing durable; the
  // snapshot is still the last complete provider conversation, so resume from
  // it and report the requests it does not contain.
  if (!Array.isArray(saved.messages) || saved.messages.length === 0)
    fail("the provider message snapshot is missing")
  const checked = checkConversationSnapshot(saved.messages)
  if (typeof checked === "string") fail(checked)
  const messages = checked
  options.initialConversation = messages
  return { unfinishedTurns: tail.unfinishedUserTurns, startsFresh: false }
}

export function createAgentSession(params: AgentSessionParams): AgentSession {
  const now = params.now ?? Date.now
  const sessionId = params.sessionId ?? mintSessionId(now())
  const home = params.home ?? resolveHome(process.env, os.homedir())
  const capture = params.capture ?? defaultCapture
  const bootstrap =
    params.bootstrap ?? ((cwd: string) => bootstrapSidecar({ cwd, env: process.env }))
  const resolveApprovedTools =
    params.resolveApprovedTools ?? (() => readToolApprovals(home, undefined, params.config.cwd))
  const resolveDisabledMcpTools = params.resolveDisabledMcpTools ?? (() => readDisabledTools(home))
  const resolveMcpServers =
    params.resolveMcpServers ??
    (() => applyDisabled(loadMcpServers([params.config.cwd, home]), readDisabled(home)))
  let activeInvocation: {
    turnId: string
    controller: AbortController
    awaitApprovals?: () => Promise<void>
  } | null = null
  const hostCalls = new Set<Promise<unknown>>()
  const subscribePluginTools =
    params.subscribePluginTools ??
    (() => {
      const execute = makeConfiguredCliPluginToolHandle(params.config)
      return subscribePluginToolDispatch({
        sessionId,
        handle: async (request) => {
          const active = activeInvocation
          const rejected = () => ({
            type: "plugin_tool_response" as const,
            sessionId: request.sessionId,
            toolUseId: request.toolUseId,
            error: "Tool invocation cancelled or belongs to an inactive turn",
          })
          if (
            !active ||
            active.controller.signal.aborted ||
            (request.turnId && request.turnId !== active.turnId)
          )
            return rejected()
          let removeAbort = () => {}
          const cancelled = new Promise<void>((resolve) => {
            const onAbort = () => resolve()
            active.controller.signal.addEventListener("abort", onAbort, { once: true })
            removeAbort = () => active.controller.signal.removeEventListener("abort", onAbort)
          })
          try {
            await Promise.race([active.awaitApprovals?.(), cancelled])
          } catch {
            return rejected()
          } finally {
            removeAbort()
          }
          if (activeInvocation !== active || active.controller.signal.aborted) return rejected()
          const pending = execute({ ...request, abortSignal: active.controller.signal })
          hostCalls.add(pending)
          try {
            return await pending
          } finally {
            hostCalls.delete(pending)
          }
        },
      })
    })
  const setSessionMode = params.setSessionMode ?? defaultSetSessionMode

  const assembler: CliContextAssembler = createCliContextAssembler({
    config: params.config,
    sessionId,
    home,
    now,
    ...(params.sessionKind ? { sessionKind: params.sessionKind } : {}),
    ...(params.resolveOptions ? { resolveOptions: params.resolveOptions } : {}),
    ...(params.buildContent ? { buildContent: params.buildContent } : {}),
    resolveMcpServers,
    ...(params.resolveSkillIds ? { resolveSkillIds: params.resolveSkillIds } : {}),
    ...(params.resolveLoadableSkills
      ? { resolveLoadableSkills: params.resolveLoadableSkills }
      : {}),
    resolveDisabledMcpTools,
    ...(params.ensureDb ? { ensureDb: params.ensureDb } : {}),
    ...(params.primePromptOverrides ? { primePromptOverrides: params.primePromptOverrides } : {}),
    resolveApprovedTools,
    ...(params.loadPluginRuntime ? { loadPluginRuntime: params.loadPluginRuntime } : {}),
    ...(params.resolveAgents ? { resolveAgents: params.resolveAgents } : {}),
    ...(params.resolveAgentMode ? { resolveAgentMode: params.resolveAgentMode } : {}),
    ...(params.fetchTwin ? { fetchTwin: params.fetchTwin } : {}),
    ...(params.onResolvedExecutionSpec
      ? { onResolvedExecutionSpec: params.onResolvedExecutionSpec }
      : {}),
    ...(params.compositionSelection ? { compositionSelection: params.compositionSelection } : {}),
  })

  let boot: SidecarBootstrap | null = null
  let readyPromise: Promise<ResolvedCliSessionContext> | null = null
  /** Set by the first restore; shown once, on the turn that follows it. */
  let pendingRestoreNotice: string | undefined
  let pluginUnsub: UnlistenFn | null = null
  // Bind this session's provider/search config so `ctx.ai.*` and
  // `ctx.agent.invokeTool` resolve to THIS session's credentials. Bound at
  // construction rather than on first use: a plugin activating during
  // bootstrap can already reach the model, and two concurrent sessions must
  // never share one binding.
  const releaseHostRuntime = bindCliSessionHostRuntime(params.config, sessionId)
  let closed = false
  let skillsAnnounced = false
  let databaseErrorShown = false
  // Twin persona: the assembler emits it once per resolved context; the sidecar
  // path folds it into the cached system prompt (the interactive channel caches
  // its SendOptions and cannot re-resolve the prompt per turn).
  let sendOptionsOverrideMode: PermissionModeValue | null = null
  let turnSequence = 0

  function publishStatus(
    session: ResolvedCliSessionContext,
    phase: "initializing" | "ready" | "failed",
    reason?: string
  ) {
    const snapshot = publishBuiltinToolHostStatus(session, phase, reason)
    params.onToolHostStatus?.(snapshot)
  }

  function ensureReady() {
    if (!readyPromise) {
      readyPromise = initializeReady().finally(() => {
        readyPromise = null
      })
    }
    return readyPromise
  }

  async function initializeReady() {
    if (closed) throw new Error("agent session is closed")
    const session = await assembler.resolveSession()
    if (closed) throw new Error("agent session is closed")
    if (!boot) {
      // Only the tail of the transcript matters for a provider-runtime resume —
      // the latest assistant snapshot plus the last non-system role. Scanning
      // backwards keeps a large transcript from being parsed a second time.
      const restored = restoreRuntimeHistory(
        session.sendOptions,
        readTranscriptTail(home, sessionId, params.transcriptFs)
      )
      pendingRestoreNotice = restored ? runtimeHistoryRestoreNotice(restored) : undefined
      publishStatus(session, "initializing")
      try {
        boot = await bootstrap(params.config.cwd)
      } catch (error) {
        publishStatus(session, "failed", error instanceof Error ? error.message : String(error))
        throw error
      }
      if (closed) throw new Error("agent session is closed")
      // The transport is now live — subscribe the plugin-tool executor so the
      // model's plugin tool calls round-trip back here for execution. This MUST
      // be unconditional: `resolveSendOptions` always appends the `ask_user`
      // elicitation tool to `options.pluginTools` AND its manifest disables the
      // 120s relay timeout, so an unsubscribed `ask_user` call hangs the turn
      // forever. Web tools, plugin tools, and `dispatch_agent` ride the same
      // wire, so a single subscription serves them too.
      if (!pluginUnsub) {
        try {
          pluginUnsub = await subscribePluginTools()
        } catch (cause) {
          const failedBoot = boot
          boot = null
          try {
            await failedBoot.shutdown()
          } catch {
            /* preserve the startup failure */
          }
          const error = new AgentSessionStartupError(cause)
          publishStatus(session, "failed", error.message)
          throw error
        }
      }
    }
    // A `/mode` switch applied to the LIVE sidecar session must survive a later
    // local read of the cached options.
    if (sendOptionsOverrideMode) session.sendOptions.permissionMode = sendOptionsOverrideMode
    if (params.fileCheckpoints) session.sendOptions.fileCheckpointFrames = true
    publishStatus(session, "ready")
    if (params.outputSchema) {
      session.sendOptions.claudeAgentSdk = {
        ...session.sendOptions.claudeAgentSdk,
        version: session.sendOptions.claudeAgentSdk?.version ?? 1,
        outputFormat: { type: "json_schema", schema: params.outputSchema },
      }
    }
    return session
  }

  return {
    sessionId,
    async prepareForSubagent() {
      await ensureReady()
    },
    async send(prompt, opts) {
      const session = await ensureReady()
      if (pendingRestoreNotice) {
        opts.onRestoreNotice?.(pendingRestoreNotice)
        pendingRestoreNotice = undefined
      }
      const sendOptions = session.sendOptions
      const turnNumber = turnSequence++
      const turnIdentity = {
        runId: `${sessionId}:r${turnNumber}`,
        turnId: `${sessionId}:t${turnNumber}`,
        attemptId: `${sessionId}:t${turnNumber}:a0`,
      }
      sendOptions.turnId = turnIdentity.turnId
      if (sendOptions.execution) {
        sendOptions.execution = {
          ...sendOptions.execution,
          identity: {
            ...sendOptions.execution.identity,
            runId: turnIdentity.runId,
            attemptId: turnIdentity.attemptId,
          },
        }
      }
      // Non-Anthropic (ai-sdk) channel agentic step budget. The sidecar's
      // `dispatchAiSdk` runs a manual agent loop and continues across tool-call
      // legs up to this many steps; without it the channel silently stopped after
      // a single 16-step leg.
      if (sendOptions.aiSdkMaxSteps === undefined && params.config.aiSdkMaxSteps !== undefined) {
        sendOptions.aiSdkMaxSteps = params.config.aiSdkMaxSteps
      }
      // Per-tool execution deadline for read-only built-ins on the ai-sdk
      // channel. Without it a file-walk tool that hangs on a huge tree keeps the
      // stream-idle watchdog paused, so the turn only dies at the wall clock.
      if (
        sendOptions.toolExecutionTimeoutMs === undefined &&
        params.config.toolExecutionTimeoutMs !== undefined
      ) {
        sendOptions.toolExecutionTimeoutMs = params.config.toolExecutionTimeoutMs
      }
      // Announce the active skills exactly once per session. After
      // `invalidateOptions` the set re-resolves and re-announces.
      if (!skillsAnnounced && session.activeSkillIds.length > 0) {
        skillsAnnounced = true
        opts.onActiveSkills?.(session.activeSkillIds)
      }
      // Report an unsafe snapshot exactly once per session: the turn succeeds,
      // but the user must hear that their data was moved aside.
      if (session.databaseError && !databaseErrorShown) {
        databaseErrorShown = true
        opts.onDatabaseError?.(session.databaseError)
      }
      const turn = await assembler.resolveTurn(prompt, session)
      const scopedSkillIds = [
        ...(session.skillLoadScope?.allowedSkillIds ?? session.activeSkillIds),
        ...(turn.contextualSkillIds ?? []),
      ]
      if (scopedSkillIds.length > 0) {
        registerCliSkillLoadContext(sessionId, {
          allowedSkillIds: scopedSkillIds,
          explicitSkillIds: session.skillLoadScope?.explicitSkillIds,
          allowDisabledSkillIds: session.skillLoadScope?.allowDisabledSkillIds,
          turnId: turnIdentity.turnId,
          attemptId: turnIdentity.attemptId,
        })
      } else {
        releaseCliSkillLoadContext(sessionId)
      }
      if (turn.twinNotice) opts.onTwinNotice?.(turn.twinNotice)
      // The twin persona is session-stable, so it appends to the cached system
      // prompt rather than riding every message.
      if (turn.stableTwinContext) {
        sendOptions.systemPrompt = sendOptions.systemPrompt
          ? `${sendOptions.systemPrompt}\n\n${turn.stableTwinContext}`
          : turn.stableTwinContext
      }
      if (turn.attachments) opts.onAttachments?.(turn.attachments)
      appendTranscript(
        home,
        sessionId,
        {
          role: "user",
          content: prompt,
          ...(turn.attachmentParts?.length
            ? {
                schemaVersion: 1 as const,
                parts: [{ type: "text" as const, text: prompt }, ...turn.attachmentParts],
              }
            : {}),
        },
        params.transcriptFs,
        now()
      )
      // Publish this turn's dispatch context so a model-driven `dispatch_agent`
      // call can launch a subagent over the live sidecar with THIS turn's gate,
      // signal, and resolved provider/MCP context.
      const clearDispatch = registerTurnSubagentContext({
        session,
        config: params.config,
        home,
        gate: opts.gate,
        ...(opts.awaitApprovals ? { awaitApprovals: opts.awaitApprovals } : {}),
        ...(params.resolveSubagentOptions
          ? { resolveSubagentOptions: params.resolveSubagentOptions }
          : {}),
        ...(params.resolveSubagentGate ? { resolveSubagentGate: params.resolveSubagentGate } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        approvedTools: resolveApprovedTools(),
        disabledMcpTools: resolveDisabledMcpTools(),
      })
      // Per-turn twin RAG rides the user content as a <twin-context> block —
      // the cached SendOptions can't carry a fresh system prompt each turn.
      const turnContent = turn.dynamicTwinContext
        ? prependTextBlock(turn.content, twinContextBlock(turn.dynamicTwinContext))
        : turn.content
      let result: RunAndCaptureResult
      const envelopeEmitter = opts.onEnvelope
        ? createEnvelopeEmitter({
            identity: {
              sessionId,
              ...turnIdentity,
              hostRef: "desktop-sidecar",
              runtime: sendOptions.execution?.runtimeAdapter ?? "builtin",
            },
            onEnvelope: (envelope) => {
              const status = observeBuiltinToolResult(sessionId, envelope.event)
              if (status) params.onToolHostStatus?.(status)
              opts.onEnvelope?.(envelope)
            },
            now: () => new Date(now()),
          })
        : undefined
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      if (opts.signal?.aborted) controller.abort()
      else opts.signal?.addEventListener("abort", onAbort, { once: true })
      const invocation = {
        turnId: turnIdentity.turnId,
        controller,
        awaitApprovals: opts.awaitApprovals,
      }
      activeInvocation = invocation
      const runtimeName =
        sendOptions.execution?.runtimeAdapter ??
        (sendOptions.provider === "anthropic" ? "claude-agent-sdk" : "ai-sdk")
      const runtimeHistoryFor = (
        sdkSessionIdFromRun: string | undefined,
        snapshot?: unknown[]
      ) => ({
        version: 1,
        runtime: runtimeName,
        provider: sendOptions.provider,
        ...(sdkSessionIdFromRun || sendOptions.resumeSessionId
          ? {
              sdkSessionId: sdkSessionIdFromRun ?? sendOptions.resumeSessionId,
              sdkSessionStorage: sdkSessionStorageFromOptions(sendOptions),
            }
          : {}),
        ...(snapshot ? { messages: snapshot } : {}),
      })
      const saveInterruptedTurn = (partial: RunAndCapturePartial): void => {
        if (partial.sdkSessionId) sendOptions.resumeSessionId = partial.sdkSessionId
        // Only a history a later restore accepts is worth recording: an entry
        // it would reject would turn a resumable session into a refused one.
        // The native SDK keeps its own record and needs only the session id.
        let snapshot: unknown[] | undefined
        if (runtimeName === "claude-agent-sdk") {
          if (!(partial.sdkSessionId || sendOptions.resumeSessionId)) return
        } else {
          if (!partial.conversationSnapshot?.length) return
          if (typeof checkConversationSnapshot(partial.conversationSnapshot) === "string") return
          snapshot = partial.conversationSnapshot
        }
        // Same rule as a completed turn: the restored seed is now consumed.
        delete sendOptions.initialConversation
        appendTranscript(
          home,
          sessionId,
          {
            role: "assistant",
            content: partial.text,
            meta: {
              model: sendOptions.model,
              provider: sendOptions.provider,
              interrupted: true,
              runtimeHistory: runtimeHistoryFor(partial.sdkSessionId, snapshot),
            },
          },
          params.transcriptFs,
          now()
        )
      }
      try {
        result = await capture(sessionId, turnContent, sendOptions, {
          // This session's history is the JSONL transcript plus the restored
          // provider snapshot above, not an app Dexie row.
          transcriptRuntime: "host-owned",
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
          // Idle (read) watchdog: interrupt a turn whose provider stream stalls
          // mid-flight.
          idleTimeoutMs: params.config.streamIdleTimeoutMs,
          onPermissionRequest: async (request) => {
            const approved = resolveApprovedTools()
            if (
              approved.has(request.toolName) ||
              approved.has(approvalKey(request.toolName, request.input))
            ) {
              return { decision: "allow" }
            }
            return opts.gate(request)
          },
          ...(envelopeEmitter
            ? {
                onCanonicalEvent: (
                  event: import("@cognia/agent-config-types/agent-execution").CanonicalAgentEvent
                ) => {
                  if (event.kind !== "diagnostic") envelopeEmitter.emit(event)
                },
              }
            : {}),
          onEvent: envelopeEmitter
            ? (event) => {
                envelopeEmitter.fromCapture(event)
              }
            : opts.onEvent,
        })
      } catch (error) {
        // An interrupted turn still did work: the steps that completed are in
        // the sidecar's snapshot. Save them as this turn's durable history so
        // `--continue` resumes from the interrupted work rather than refusing,
        // or silently dropping everything the turn did.
        if (error instanceof RunAndCaptureError && error.code === "aborted" && error.partial) {
          saveInterruptedTurn(error.partial)
        }
        throw error
      } finally {
        controller.abort()
        opts.signal?.removeEventListener("abort", onAbort)
        if (activeInvocation === invocation) activeInvocation = null
        releaseCliSkillLoadContext(sessionId)
        clearDispatch()
        // Defensive: `registerTurnSubagentContext` is a no-op when the tool was
        // never surfaced, so clear unconditionally in case a nested run left an
        // entry behind.
        clearCliSubagentContext(sessionId)
      }
      if (envelopeEmitter) {
        for (const surfaceId of result.a2uiSurfaceOrder) {
          const surface = result.a2uiSurfaces[surfaceId]
          if (!surface) continue
          envelopeEmitter.emit({
            kind: "content-part",
            partId: `a2ui:${surfaceId}`,
            operation: "upsert",
            part: {
              type: "a2ui",
              surfaceId,
              source: "mcp-bridge",
              payload: { ...surface },
            },
          })
        }
      }
      if (result.sdkSessionId) sendOptions.resumeSessionId = result.sdkSessionId
      // A restored provider snapshot seeds the first completed turn only. The
      // sidecar restarts any session whose send carries one (`restartReason`),
      // so leaving it set replayed the saved history on every later turn and
      // dropped each live turn after a `--continue`. A failed turn keeps it,
      // because the durable history still ends where the snapshot does.
      delete sendOptions.initialConversation
      appendTranscript(
        home,
        sessionId,
        {
          role: "assistant",
          content: result.text,
          meta: {
            model: sendOptions.model,
            provider: sendOptions.provider,
            ...(result.usage ? { usage: result.usage } : {}),
            runtimeHistory: runtimeHistoryFor(result.sdkSessionId, result.conversationSnapshot),
          },
        },
        params.transcriptFs,
        now()
      )
      return result
    },
    invalidateOptions() {
      assembler.invalidate()
      // Re-resolve skills next turn and re-announce them (the user may have just
      // toggled a skill via `/skill`). The rebuilt options also lose the appended
      // twin persona, which the assembler re-emits on the next grounded turn.
      skillsAnnounced = false
      sendOptionsOverrideMode = null
    },
    async setPermissionMode(mode) {
      // Before the sidecar has spawned there is no live session to mutate — the
      // mode is already in `params.config` and folds into the first
      // `startSession` via the resolver. Do nothing (and never respawn).
      if (closed || boot === null || turnSequence === 0) return true
      await setSessionMode(sessionId, mode)
      // Keep the cached options coherent so a later local read reflects the
      // live mode.
      sendOptionsOverrideMode = mode
      const cached = assembler.peek()
      if (cached) {
        cached.sendOptions.permissionMode = mode
        params.onToolHostStatus?.(publishBuiltinToolHostStatus(cached, "ready"))
      }
      // The sidecar takes it live, every time: this path is the reason the
      // contract can promise "in force now" at all.
      return true
    },
    isLive() {
      return boot !== null && turnSequence > 0 && !closed
    },
    async close() {
      if (closed) return
      closed = true
      // A cold manual dispatch may still be starting the owned transport.
      // Wait for it before detaching subscribers and shutting that transport down.
      await readyPromise?.catch(() => undefined)
      activeInvocation?.controller.abort()
      activeInvocation = null
      // Bridge unsubscribe only removes the owner; accepted child calls must
      // finish interruption and journal writes before transport/storage retire.
      await Promise.allSettled([...hostCalls])
      clearToolHostStatus(sessionId)
      // Drop any lingering dispatch context (defensive — `send` clears it per
      // turn, but a close mid-turn must not leave a stale entry behind).
      clearCliSubagentContext(sessionId)
      releaseHostRuntime()
      if (pluginUnsub) {
        try {
          await pluginUnsub()
        } catch {
          // best-effort detach
        }
        pluginUnsub = null
      }
      if (boot) await boot.shutdown()
    },
  }
}
