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

import {
  resolveSendOptions as defaultResolveSendOptions,
  type BuildOptionsContext,
} from "@/lib/claude/build-options"
import {
  runAndCaptureAssistantReply as defaultCapture,
  type RunAndCaptureResult,
  type CaptureStreamEvent,
} from "@/lib/claude/run-and-capture"
import type { SendOptions } from "@/lib/claude/types"

import type { McpServer } from "@/lib/claude/types"
import { listBuiltinTools, namespaced } from "@/lib/settings/builtin-tools"

import { buildSendContent, type BuiltSendContent } from "./image-input"
import { resolveHome } from "../config/load"
import { type ResolvedConfig } from "../config/schema"
import { toBuildContext } from "../config/to-build-context"
import { loadMcpServers } from "../mcp/load-mcp-config"
import { applyDisabled, readDisabled } from "../mcp/mcp-state"
import { readEnabled } from "../skill/skill-state"
import { bootstrapSidecar, type SidecarBootstrap } from "../runtime/bootstrap"
import { ensurePluginRuntime } from "../plugin/plugin-runtime"
import { subscribePluginToolDispatch } from "../plugin/plugin-tool-dispatch"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { mintSessionId } from "./run"
import { type PermissionResponder } from "./permission-gate"
import { readToolApprovals } from "./tool-approvals"
import { appendTranscript, type TranscriptFs } from "./transcript"

/**
 * Built-in tools the CLI auto-approves — DERIVED from the shared risk model
 * (`lib/settings/builtin-tools-data.json`): every tool marked
 * `requiresApproval: false` (riskLevel "low"). That is the full read-only /
 * inspection surface — reads, greps, globs, `git status|log|diff`, process &
 * env listing, LSP queries, `terminal_repl_read`, `TodoWrite`, file_info/hash/
 * diff/search, … — roughly 30 tools, not a hand-kept 4. Deriving from the
 * metadata is the point: a newly added read-only tool is auto-approved
 * automatically, and a tool reclassified as risky starts prompting again — no
 * drift between the gate and the catalogue. Mutating / side-effecting tools
 * (write/edit/multi_edit/bash, file_append/move/copy/rename, directory_create/
 * delete, start/terminate_process, shell_execute_advanced, terminal_repl_spawn/
 * write/kill, …) keep `requiresApproval: true` and still hit the approval gate.
 *
 * Why the CLI needs this: the desktop persists the user's "always allow" choices
 * in a store the CLI has no equivalent of, so without it every safe read tool
 * would pop a mid-stream approval that blocks the whole turn until answered.
 * The doom-loop guard still forces a prompt on a runaway identical repeat.
 * Names are the gate's namespaced form (`mcp__cognia-tools__<name>`).
 */
export const CLI_AUTO_APPROVED_TOOLS: readonly string[] = listBuiltinTools()
  .filter((t) => !t.requiresApproval)
  .map((t) => namespaced(t.name))

/**
 * Merge the CLI's auto-approve set into the resolved options' approval
 * suppressions, preserving anything the resolver already set. `extraApproved`
 * carries the user's persisted "Allow always" choices
 * ({@link readToolApprovals}) so a tool approved-always once never prompts
 * again — including risky tools (bash/write) the user explicitly trusted.
 */
export function withCliAutoApprovedTools(
  options: SendOptions,
  extraApproved: Iterable<string> = []
): SendOptions {
  const existing = Array.isArray(options.suppressApprovalForTools)
    ? options.suppressApprovalForTools
    : []
  const merged = [...new Set([...existing, ...CLI_AUTO_APPROVED_TOOLS, ...extraApproved])]
  return { ...options, suppressApprovalForTools: merged }
}

export interface AgentSessionParams {
  config: ResolvedConfig
  sessionId?: string
  home?: string
  bootstrap?: (cwd: string) => Promise<SidecarBootstrap>
  resolveOptions?: (ctx: BuildOptionsContext) => Promise<SendOptions>
  capture?: typeof defaultCapture
  transcriptFs?: TranscriptFs
  /** Assemble multimodal content from a typed prompt (encode `@image` refs).
   * Defaults to {@link buildSendContent}; injected in tests. */
  buildContent?: (prompt: string, cwd: string) => BuiltSendContent
  /** Resolve the MCP servers to expose. Defaults to loading `.mcp.json` from
   * the cwd + home, applying the `/mcp disable` overlay. */
  resolveMcpServers?: () => McpServer[]
  /** Resolve the session-enabled skill ids. Defaults to the `/skill` state file. */
  resolveSkillIds?: () => string[]
  /** Resolve the user's persisted "Allow always" tool names. Defaults to the
   * `tool-approvals.json` store; injected in tests. */
  resolveApprovedTools?: () => Set<string>
  /** Bootstrap the in-tree plugin runtime (only when `config.pluginTools`).
   * Defaults to {@link ensurePluginRuntime}; injected as a no-op in tests. */
  loadPluginRuntime?: () => Promise<unknown>
  /** Subscribe the `plugin_tool_exec` executor after the sidecar is live (only
   * when `config.pluginTools`). Defaults to {@link subscribePluginToolDispatch}. */
  subscribePluginTools?: () => Promise<UnlistenFn>
  now?: () => number
}

export interface SendTurnOptions {
  gate: PermissionResponder
  onEvent?: (event: CaptureStreamEvent) => void
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
  close(): Promise<void>
}

/**
 * Create a persistent agent session. Lazy: the sidecar spawns + options resolve
 * on the first `send`. Subsequent sends reuse both.
 */
export function createAgentSession(params: AgentSessionParams): AgentSession {
  const now = params.now ?? Date.now
  const sessionId = params.sessionId ?? mintSessionId(now())
  const home = params.home ?? resolveHome(process.env, os.homedir())
  const resolveOptions = params.resolveOptions ?? defaultResolveSendOptions
  const capture = params.capture ?? defaultCapture
  const bootstrap =
    params.bootstrap ?? ((cwd: string) => bootstrapSidecar({ cwd, env: process.env }))
  const resolveMcpServers =
    params.resolveMcpServers ??
    (() => {
      const roots = [params.config.cwd, home]
      return applyDisabled(loadMcpServers(roots), readDisabled(home))
    })
  const resolveSkillIds = params.resolveSkillIds ?? (() => [...readEnabled(home)])
  const resolveApprovedTools = params.resolveApprovedTools ?? (() => readToolApprovals(home))
  const pluginToolsEnabled = params.config.pluginTools === true
  const loadPluginRuntime = params.loadPluginRuntime ?? (() => ensurePluginRuntime())
  const subscribePluginTools = params.subscribePluginTools ?? (() => subscribePluginToolDispatch())
  const buildContent = params.buildContent ?? buildSendContent

  let boot: SidecarBootstrap | null = null
  let options: SendOptions | null = null
  let pluginUnsub: UnlistenFn | null = null
  let closed = false

  async function ensureReady(): Promise<SendOptions> {
    if (closed) throw new Error("agent session is closed")
    if (!options) {
      // Hydrate the in-tree plugin runtime BEFORE resolving options so
      // `buildPluginToolsManifest` (inside `resolveSendOptions`) sees the
      // plugins. Graceful: a failure leaves the manifest empty, chat unaffected.
      if (pluginToolsEnabled) await loadPluginRuntime()
      const ctx = toBuildContext({
        sessionId,
        config: params.config,
        mcpServers: resolveMcpServers(),
        ephemeralSkillIds: resolveSkillIds(),
        now: now(),
      })
      options = withCliAutoApprovedTools(await resolveOptions(ctx), resolveApprovedTools())
    }
    if (!boot) {
      boot = await bootstrap(params.config.cwd)
      // The transport is now live — subscribe the plugin-tool executor so the
      // model's plugin tool calls round-trip back here for execution.
      if (pluginToolsEnabled && !pluginUnsub) {
        pluginUnsub = await subscribePluginTools().catch(() => null)
      }
    }
    return options
  }

  return {
    sessionId,
    async send(prompt, opts) {
      const sendOptions = await ensureReady()
      // Encode any `@image` references into multimodal content blocks. The
      // transcript keeps the typed text; only the wire payload carries images.
      const built = buildContent(prompt, params.config.cwd)
      appendTranscript(
        home,
        sessionId,
        { role: "user", content: prompt },
        params.transcriptFs,
        now()
      )
      const result = await capture(sessionId, built.content, sendOptions, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        onPermissionRequest: opts.gate,
        onEvent: opts.onEvent,
      })
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
      options = null
    },
    async close() {
      if (closed) return
      closed = true
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
