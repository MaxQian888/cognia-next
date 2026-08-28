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
import { type ResolvedConfig } from "../config/schema"
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
import { readToolApprovals } from "./tool-approvals"
import { appendTranscript, type TranscriptFs } from "./transcript"
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
import { type LoadableSkill } from "./skill-load-tool"
import {
  createCliContextAssembler,
  prependTextBlock,
  twinContextBlock,
  type AttachmentSummary,
  type CliContextAssembler,
} from "./session-context"
import { registerTurnSubagentContext } from "./turn-dispatch"
import { createEnvelopeEmitter } from "./runtime/turn-events"

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
}

/** A model option exposed by the external agent that is currently hosting a session. */
export interface AgentModelOption {
  id: string
  name?: string
}

export interface SendTurnOptions {
  gate: PermissionResponder
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

export interface AgentSession {
  readonly sessionId: string
  send(prompt: string, opts: SendTurnOptions): Promise<RunAndCaptureResult>
  /** Drop the cached SendOptions so the next `send` re-resolves them — used
   * after `/mcp`, `/skill`, or `/plugin` toggle a server/skill mid-session.
   * Optional so lightweight test doubles need not implement it. */
  invalidateOptions?(): void
  /** Mutate the live session's permission mode in place (no respawn), so the
   * in-process conversation is preserved across a Shift+Tab / plan-approval
   * mode switch. A no-op before the sidecar has spawned — the mode then folds
   * into the first `startSession`. Optional for lightweight test doubles. */
  setPermissionMode?(mode: PermissionModeValue): Promise<void>
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
export function createAgentSession(params: AgentSessionParams): AgentSession {
  const now = params.now ?? Date.now
  const sessionId = params.sessionId ?? mintSessionId(now())
  const home = params.home ?? resolveHome(process.env, os.homedir())
  const capture = params.capture ?? defaultCapture
  const bootstrap =
    params.bootstrap ?? ((cwd: string) => bootstrapSidecar({ cwd, env: process.env }))
  const resolveApprovedTools = params.resolveApprovedTools ?? (() => readToolApprovals(home))
  const resolveDisabledMcpTools = params.resolveDisabledMcpTools ?? (() => readDisabledTools(home))
  const resolveMcpServers =
    params.resolveMcpServers ??
    (() => applyDisabled(loadMcpServers([params.config.cwd, home]), readDisabled(home)))
  const subscribePluginTools =
    params.subscribePluginTools ??
    (() =>
      subscribePluginToolDispatch({
        handle: makeConfiguredCliPluginToolHandle(params.config),
      }))
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

  async function ensureReady() {
    if (closed) throw new Error("agent session is closed")
    const session = await assembler.resolveSession()
    if (!boot) {
      boot = await bootstrap(params.config.cwd)
      // The transport is now live — subscribe the plugin-tool executor so the
      // model's plugin tool calls round-trip back here for execution. This MUST
      // be unconditional: `resolveSendOptions` always appends the `ask_user`
      // elicitation tool to `options.pluginTools` AND its manifest disables the
      // 120s relay timeout, so an unsubscribed `ask_user` call hangs the turn
      // forever. Web tools, plugin tools, and `dispatch_agent` ride the same
      // wire, so a single subscription serves them too.
      if (!pluginUnsub) {
        pluginUnsub = await subscribePluginTools().catch(() => null)
      }
    }
    // A `/mode` switch applied to the LIVE sidecar session must survive a later
    // local read of the cached options.
    if (sendOptionsOverrideMode) session.sendOptions.permissionMode = sendOptionsOverrideMode
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
    async send(prompt, opts) {
      const session = await ensureReady()
      const sendOptions = session.sendOptions
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
        { role: "user", content: prompt },
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
      const turnNumber = turnSequence++
      const envelopeEmitter = opts.onEnvelope
        ? createEnvelopeEmitter({
            identity: {
              sessionId,
              runId: `${sessionId}:r${turnNumber}`,
              turnId: `${sessionId}:t${turnNumber}`,
              attemptId: `${sessionId}:t${turnNumber}:a0`,
              hostRef: "desktop-sidecar",
              runtime: sendOptions.execution?.runtimeAdapter ?? "builtin",
            },
            onEnvelope: opts.onEnvelope,
            now: () => new Date(now()),
          })
        : undefined
      try {
        result = await capture(sessionId, turnContent, sendOptions, {
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
          // Idle (read) watchdog: interrupt a turn whose provider stream stalls
          // mid-flight.
          idleTimeoutMs: params.config.streamIdleTimeoutMs,
          onPermissionRequest: opts.gate,
          onEvent: envelopeEmitter
            ? (event) => {
                envelopeEmitter.fromCapture(event)
              }
            : opts.onEvent,
        })
      } finally {
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
      if (closed || boot === null) return
      await setSessionMode(sessionId, mode)
      // Keep the cached options coherent so a later local read reflects the
      // live mode.
      sendOptionsOverrideMode = mode
      const cached = assembler.peek()
      if (cached) cached.sendOptions.permissionMode = mode
    },
    isLive() {
      return boot !== null && !closed
    },
    async close() {
      if (closed) return
      closed = true
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
