/**
 * Headless agent turn orchestrator.
 *
 * Wires the reuse seams end to end:
 *   config → toBuildContext → resolveSendOptions (REUSED desktop assembly)
 *   → bootstrap sidecar (StdioTransport) → runAndCaptureAssistantReply (REUSED)
 *   → transcript.
 *
 * Every collaborator is injectable so the orchestration unit-tests without a
 * live sidecar or model.
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
import type { McpServer, SendOptions } from "@/lib/claude/types"

import type { UnlistenFn } from "@tauri-apps/api/event"

import { resolveHome } from "../config/load"
import { type ResolvedConfig } from "../config/schema"
import { toBuildContext } from "../config/to-build-context"
import { loadMcpServers } from "../mcp/load-mcp-config"
import { applyDisabled, readDisabled } from "../mcp/mcp-state"
import { readEnabled } from "../skill/skill-state"
import { ensureCliDb } from "../db/bootstrap"
import { bootstrapSidecar, type SidecarBootstrap } from "../runtime/bootstrap"
import { ensurePluginRuntime } from "../plugin/plugin-runtime"
import { subscribePluginToolDispatch } from "../plugin/plugin-tool-dispatch"
import { type PermissionResponder } from "./permission-gate"
import { appendTranscript, type TranscriptFs } from "./transcript"

/** Mint a session id matching the desktop's `s_<base36ts><rand>` convention. */
export function mintSessionId(now: number = Date.now(), rand: number = Math.random()): string {
  return `s_${now.toString(36)}${rand.toString(36).slice(2, 8)}`
}

export interface RunHeadlessParams {
  config: ResolvedConfig
  prompt: string
  /** Reuse an existing session id (resume/handoff); minted when omitted. */
  sessionId?: string
  /** Permission responder (from `createPermissionGate`). */
  gate: PermissionResponder
  /** Incremental stream events for rendering. */
  onEvent?: (event: CaptureStreamEvent) => void
  signal?: AbortSignal
  timeoutMs?: number
  /** CLI home for the transcript; defaults to `resolveHome(process.env, os.homedir())`. */
  home?: string

  // ---- Injected collaborators (tests / advanced wiring) ------------------
  bootstrap?: (cwd: string) => Promise<SidecarBootstrap>
  resolveOptions?: (ctx: BuildOptionsContext) => Promise<SendOptions>
  capture?: typeof defaultCapture
  transcriptFs?: TranscriptFs
  /** Hydrate the in-tree plugin runtime (only when `config.pluginTools`) so the
   * manifest inside `resolveOptions` sees the plugins. Injected in tests. */
  loadPluginRuntime?: () => Promise<unknown>
  /** Subscribe the `plugin_tool_exec` executor after the sidecar is live (only
   * when `config.pluginTools`). Injected in tests. */
  subscribePluginTools?: () => Promise<UnlistenFn>
  /** Resolve the MCP servers to expose. Defaults to loading `.mcp.json` from the
   * cwd + home, applying the `/mcp disable` overlay. Injected in tests. */
  resolveMcpServers?: () => McpServer[]
  /** Resolve the session-enabled skill ids. Defaults to the `/skill` state file. */
  resolveSkillIds?: () => string[]
  /** Open the CLI-local Dexie (installs the `window` + IndexedDB shims `getDb()`
   * requires) before resolving options — only when a skill is enabled, the lone
   * build-options read that routes through Dexie. Defaults to {@link ensureCliDb}. */
  ensureDb?: () => Promise<unknown>
  now?: number
}

export interface RunHeadlessResult {
  sessionId: string
  text: string
  usage?: RunAndCaptureResult["usage"]
  sdkSessionId?: string
}

/** Run one headless agent turn and return its captured reply. */
export async function runHeadlessTurn(params: RunHeadlessParams): Promise<RunHeadlessResult> {
  const now = params.now ?? Date.now()
  const sessionId = params.sessionId ?? mintSessionId(now)
  const home = params.home ?? resolveHome(process.env, os.homedir())

  // Hydrate the in-tree plugin runtime BEFORE resolving options so the manifest
  // built inside `resolveSendOptions` sees the plugins (mirrors session-runner).
  // Graceful: a failure leaves the manifest empty, the turn unaffected.
  const pluginToolsEnabled = params.config.pluginTools === true
  if (pluginToolsEnabled) {
    await (params.loadPluginRuntime ?? (() => ensurePluginRuntime()))()
  }

  // Resolve the MCP servers + session-enabled skills exactly like the persistent
  // session does, so a headless `run` honors `.mcp.json` and `/skill` state too.
  const resolveMcpServers =
    params.resolveMcpServers ??
    (() => applyDisabled(loadMcpServers([params.config.cwd, home]), readDisabled(home)))
  const resolveSkillIds = params.resolveSkillIds ?? (() => [...readEnabled(home)])
  const ensureDb = params.ensureDb ?? (() => ensureCliDb())
  let ephemeralSkillIds = resolveSkillIds()
  // Skills are read from Dexie in build-options; open the CLI db first (only when
  // a skill is enabled). Degrade gracefully — a db failure drops skills rather
  // than crashing the turn (mirrors session-runner).
  if (ephemeralSkillIds.length > 0) {
    try {
      await ensureDb()
    } catch {
      ephemeralSkillIds = []
    }
  }

  const ctx = toBuildContext({
    sessionId,
    config: params.config,
    mcpServers: resolveMcpServers(),
    ephemeralSkillIds,
    now,
  })
  const resolveOptions = params.resolveOptions ?? defaultResolveSendOptions
  const options = await resolveOptions(ctx)

  const bootstrap =
    params.bootstrap ?? ((cwd: string) => bootstrapSidecar({ cwd, env: process.env }))
  const boot = await bootstrap(params.config.cwd)

  // The transport is now live — subscribe the plugin-tool executor so the
  // model's plugin tool calls round-trip back here for execution.
  let pluginUnsub: UnlistenFn | null = null
  if (pluginToolsEnabled) {
    pluginUnsub = await (
      params.subscribePluginTools ?? (() => subscribePluginToolDispatch())
    )().catch(() => null)
  }

  const capture = params.capture ?? defaultCapture
  try {
    appendTranscript(
      home,
      sessionId,
      { role: "user", content: params.prompt },
      params.transcriptFs,
      now
    )
    const result = await capture(sessionId, params.prompt, options, {
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      onPermissionRequest: params.gate,
      onEvent: params.onEvent,
    })
    appendTranscript(
      home,
      sessionId,
      {
        role: "assistant",
        content: result.text,
        meta: {
          model: options.model,
          provider: options.provider,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.sdkSessionId ? { sdkSessionId: result.sdkSessionId } : {}),
        },
      },
      params.transcriptFs,
      params.now ?? Date.now()
    )
    return {
      sessionId,
      text: result.text,
      usage: result.usage,
      sdkSessionId: result.sdkSessionId,
    }
  } finally {
    if (pluginUnsub) {
      try {
        await pluginUnsub()
      } catch {
        // best-effort detach
      }
    }
    await boot.shutdown()
  }
}
