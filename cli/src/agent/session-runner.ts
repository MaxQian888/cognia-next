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
import { setSessionMode as defaultSetSessionMode } from "@/lib/claude/ipc"
import type { SendOptions } from "@/lib/claude/types"

/** A concrete permission mode value (excludes `undefined`). */
type PermissionModeValue = NonNullable<SendOptions["permissionMode"]>

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
import { ensureCliDb } from "../db/bootstrap"
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
export const CLI_AUTO_APPROVED_TOOLS: readonly string[] = [
  ...listBuiltinTools()
    .filter((t) => !t.requiresApproval)
    .map((t) => namespaced(t.name)),
  // The plan-ready signal tools never hit the generic approval prompt — the
  // plan-approval overlay drives that decision. `exit_plan_mode` is the
  // cross-provider cognia builtin (not in the metadata, so add it explicitly);
  // `ExitPlanMode` is the SDK-native Anthropic tool (belt-and-suspenders — the
  // SDK likely routes it through its own plan-approval control, not the gate).
  namespaced("exit_plan_mode"),
  "ExitPlanMode",
]

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
  /** Subscribe the `plugin_tool_exec` executor after the sidecar is live (only
   * when `config.pluginTools`). Defaults to {@link subscribePluginToolDispatch}. */
  subscribePluginTools?: () => Promise<UnlistenFn>
  /** Send the `claude_set_mode` control message to mutate the LIVE session's
   * permission mode without respawning the sidecar. Defaults to the ipc
   * {@link defaultSetSessionMode}; injected in tests. */
  setSessionMode?: (sessionId: string, mode: PermissionModeValue) => Promise<void>
  now?: () => number
}

export interface SendTurnOptions {
  gate: PermissionResponder
  onEvent?: (event: CaptureStreamEvent) => void
  /** Fired once per session, on the first turn that loads session-enabled
   * skills, with the skill ids that resolved into the prompt. Lets the UI show
   * the user which skills are active. Not fired for plain (skill-less) chat. */
  onActiveSkills?: (skillIds: string[]) => void
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
  const ensureDb = params.ensureDb ?? (() => ensureCliDb())
  const resolveApprovedTools = params.resolveApprovedTools ?? (() => readToolApprovals(home))
  const pluginToolsEnabled = params.config.pluginTools === true
  const loadPluginRuntime = params.loadPluginRuntime ?? (() => ensurePluginRuntime())
  const subscribePluginTools = params.subscribePluginTools ?? (() => subscribePluginToolDispatch())
  const setSessionMode = params.setSessionMode ?? defaultSetSessionMode
  const buildContent = params.buildContent ?? buildSendContent

  let boot: SidecarBootstrap | null = null
  let options: SendOptions | null = null
  let pluginUnsub: UnlistenFn | null = null
  let closed = false
  // The skill ids that resolved into the prompt (≤ once-resolved, since options
  // are cached). Surfaced to the UI via `onActiveSkills` on the first send.
  let activeSkillIds: string[] = []
  let skillsAnnounced = false

  async function ensureReady(): Promise<SendOptions> {
    if (closed) throw new Error("agent session is closed")
    if (!options) {
      // Hydrate the in-tree plugin runtime BEFORE resolving options so
      // `buildPluginToolsManifest` (inside `resolveSendOptions`) sees the
      // plugins. Graceful: a failure leaves the manifest empty, chat unaffected.
      if (pluginToolsEnabled) await loadPluginRuntime()
      let ephemeralSkillIds = resolveSkillIds()
      // The desktop build-options pipeline reads enabled skills from Dexie via
      // `getDb()`, which throws "getDb() called on the server" unless the
      // CLI-local db (and its `window` + IndexedDB shims) is open. Plain chat
      // touches no Dexie table, so open it lazily — only when a skill is enabled
      // (commonly carried over from a prior session's `/skill` state file).
      // Mirrors the goal/memory/tasks controllers, which open the db first too.
      if (ephemeralSkillIds.length > 0) {
        try {
          await ensureDb()
        } catch {
          // Opening the CLI-local db failed (corrupt snapshot, locked file, …).
          // Degrade gracefully: resolve options WITHOUT skills rather than let
          // the build-options Dexie read crash the whole turn. Chat still works;
          // the skills just don't attach this session.
          ephemeralSkillIds = []
        }
      }
      activeSkillIds = ephemeralSkillIds
      const ctx = toBuildContext({
        sessionId,
        config: params.config,
        mcpServers: resolveMcpServers(),
        ephemeralSkillIds,
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
      // Announce the active skills exactly once per session, so the user sees
      // which skills attached to their chat. After `invalidateOptions` (e.g. a
      // `/skill` toggle) the set re-resolves and re-announces.
      if (!skillsAnnounced && activeSkillIds.length > 0) {
        skillsAnnounced = true
        opts.onActiveSkills?.(activeSkillIds)
      }
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
      // Re-resolve skills next turn and re-announce them (the user may have
      // just toggled a skill via `/skill`).
      skillsAnnounced = false
    },
    async setPermissionMode(mode) {
      // Before the sidecar has spawned there is no live session to mutate — the
      // mode is already in `params.config` and folds into the first
      // `startSession` via `resolveOptions`. Do nothing (and never respawn).
      if (closed || boot === null) return
      await setSessionMode(sessionId, mode)
      // Keep the cached options coherent so a later `invalidateOptions` +
      // re-resolve (or any local read) reflects the live mode.
      if (options) options = { ...options, permissionMode: mode }
    },
    isLive() {
      return boot !== null && !closed
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
