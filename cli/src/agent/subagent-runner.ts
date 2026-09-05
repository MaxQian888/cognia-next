/**
 * CLI-native subagent runner.
 *
 * Runs ONE subagent turn over the SAME live sidecar the chat session already
 * spawned — NOT the desktop's `executeAgent`/`dispatchSubagent` path, which
 * gates the tool-enabled channel on `isTauri()` (false in the CLI) and reads its
 * provider + settings from Dexie (the CLI authenticates from `config`, not the
 * renderer settings store). Instead we shape the subagent's definition into a
 * cloned {@link ResolvedConfig}, resolve send options through the SAME
 * `resolveSendOptions` the main turn uses, and drive
 * `runAndCaptureAssistantReply` on a fresh child session id over the live
 * transport. The result reads back inline as the dispatching tool's output.
 *
 * Depth policy: nesting is depth-tracked, not leaf-only. When the dispatcher
 * passes a {@link CliSubagentNesting} seam (only while the child would run
 * BELOW the configured `subagentMaxDepth`), the child's send options re-surface
 * the `dispatch_agent` tool and a dispatch context is registered under the
 * child session id — so a subagent can itself delegate, with the depth cap,
 * cycle guard, and shared root-session ownership enforced by the dispatch
 * handler. At the cap the seam is omitted and the child runs as a leaf (the
 * depth-N generalization of Claude Code dropping the Agent tool from
 * subagents; mirrors the desktop's `dispatch_agent` path).
 */

import {
  resolveSendOptions as defaultResolveSendOptions,
  type BuildOptionsContext,
} from "@/lib/claude/build-options"
import {
  runAndCaptureAssistantReply as defaultCapture,
  type CaptureStreamEvent,
  type RunAndCaptureResult,
} from "@/lib/claude/run-and-capture"
import { closeSession as defaultCloseSession } from "@/lib/claude/ipc"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { McpServer, SendOptions } from "@cognia/agent-config-types"
import type { PluginToolManifestEntry } from "@/lib/plugin/bridge/sidecar-tools-bridge"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

import { type ResolvedConfig } from "../config/schema"
import { toBuildContext } from "../config/to-build-context"
import { hasAnyHookGroup, resolveCliHooksConfig } from "../hooks/resolve-hooks-config"
import { type PermissionResponder } from "./permission-gate"
import { approvalKey } from "./command-approval"
import { withCliAutoApprovedTools, withCliDisabledMcpTools } from "./tool-suppression"

/**
 * Nesting seam handed down by the dispatch handler when the child is allowed to
 * delegate further (i.e. it would run BELOW the configured max depth). The
 * runner stays registry-agnostic: it only knows the child session id, so the
 * dispatcher supplies the manifest to advertise plus register/unregister
 * callbacks that publish/retire the child's dispatch context under that id.
 */
export interface CliSubagentNesting {
  /** `dispatch_agent` manifest to advertise to the child (`null` ⇒ none). */
  manifest: PluginToolManifestEntry | null
  /** Publish the child's dispatch context once its session id is minted. */
  register: (childSessionId: string) => void
  /** Retire the child's dispatch context when the run settles (always called). */
  unregister: (childSessionId: string) => void
}

/** Everything a subagent run needs that the dispatching turn already resolved. */
export interface RunCliSubagentDeps {
  /** The parent session's resolved CLI config (provider, credentials, cwd, …). */
  config: ResolvedConfig
  /** Config home (`~/.cognia`) — currently only forwarded for parity/tests. */
  home: string
  /** Working directory the subagent run is scoped to. */
  cwd: string
  /** The parent turn's permission responder — the subagent's tool approvals
   * round-trip through the SAME gate (so the user approves them in the TUI). */
  gate: PermissionResponder
  /** Abort signal shared with the parent turn (interrupt cancels children too). */
  signal?: AbortSignal
  /** MCP servers to expose to the subagent (the parent's resolved set). */
  mcpServers: McpServer[]
  /** The user's persisted "Allow always" tool names. */
  approvedTools: Set<string>
  /** The per-tool MCP disable overlay to union into `disallowedTools`. */
  disabledMcpTools: Set<string>
  /** Live-output sink: receives the subagent's streamed text / thinking / tool
   * events so the TUI's agent run-page can watch the run token-by-token. The
   * SAME {@link CaptureStreamEvent} stream the main turn parses — best-effort, so
   * a throwing sink never affects the run. Omitted ⇒ no live capture. */
  onEvent?: (event: CaptureStreamEvent) => void
  /** Present ⇔ the child may itself dispatch (depth-gated by the caller):
   * advertises `dispatch_agent` to the child and registers its dispatch
   * context for the duration of the run. Omitted ⇒ the child is a leaf. */
  nesting?: CliSubagentNesting
  // ── Injected seams (tests) ──────────────────────────────────────────────────
  /** The merged lifecycle-hook config to hand the child turn. */
  resolveHooks?: () => SendOptions["hooks"]
  resolveOptions?: (ctx: BuildOptionsContext) => Promise<SendOptions>
  capture?: typeof defaultCapture
  closeSession?: (sessionId: string) => Promise<void>
  now?: () => number
  /** Mint the child session id suffix (defaults to a short random token). */
  mintId?: () => string
}

/** The subset of a subagent run the dispatching tool surfaces to the model. */
export interface CliSubagentResult {
  text: string
  usage?: UsageInfo
  /** The SDK result subtype (`"success"` / `"error_max_turns"` / …) when seen. */
  finishReason?: string
}

function defaultMintId(): string {
  try {
    return crypto.randomUUID().slice(0, 8)
  } catch {
    return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  }
}

/**
 * Build the cloned config the subagent runs with: the parent config with the
 * subagent's identity (`prompt`), provider, model, and tool allowlist overlaid.
 * The `outputStyle` is dropped so the parent's response-mode append never leaks
 * into the subagent's system prompt (its `prompt` IS its identity).
 *
 * Provider resolution (cross-provider subagents):
 *   - `def.provider` set AND configured → the subagent runs on THAT provider
 *     with its own credentials (a DeepSeek chat can delegate to a Claude agent).
 *     `toBuildContext` derives the credential env / providerSettings from the
 *     child's `provider`, so switching it is sufficient to re-route + re-auth.
 *   - `def.provider` set but NOT configured → fall back to the parent provider
 *     and DROP `def.model` (it would name a model the parent can't serve), so a
 *     stale / unavailable provider never breaks the dispatch.
 *   - `def.provider` omitted → inherit the parent provider; `def.model` (if any)
 *     swaps the model within it.
 */
function buildChildConfig(config: ResolvedConfig, def: PluginSubagentDef): ResolvedConfig {
  const child: ResolvedConfig = {
    ...config,
    systemPrompt: def.prompt,
    outputStyle: undefined,
    ...(def.tools && def.tools.length > 0 ? { allowedTools: def.tools } : {}),
  }
  // `null` = a provider was requested but isn't configured (inherit parent, no
  // model swap); a string = the effective provider; `undefined` = none requested.
  const requested = def.provider
    ? config.providers[def.provider]
      ? def.provider
      : null
    : undefined
  if (requested === null) return child // unknown provider → inherit parent fully

  const provider = requested ?? config.provider
  child.provider = provider
  // `resolveActiveModel` reads the ACTIVE provider's remembered model first, then
  // the catalog default, and only falls back to the top-level `config.model` — so
  // a subagent's `model` override must land in the per-provider slot, otherwise
  // the provider's catalog default silently wins and the override is ignored.
  if (def.model) {
    child.model = def.model
    child.providers = {
      ...config.providers,
      [provider]: { ...config.providers[provider], model: def.model },
    }
  }
  return child
}

/**
 * Run a single subagent turn and resolve with its captured reply. Never deletes
 * the parent session — it mints a fresh child session id, runs one turn, and
 * closes that child session afterwards so the sidecar retires its loop.
 *
 * @param def              the subagent definition (prompt / model / tools / maxTurns)
 * @param prompt           the task prompt handed to the subagent
 * @param parentSessionId  the dispatching session (child ids are namespaced under it)
 */
export async function runCliSubagent(
  def: PluginSubagentDef,
  prompt: string,
  parentSessionId: string,
  deps: RunCliSubagentDeps
): Promise<CliSubagentResult> {
  deps.signal?.throwIfAborted()
  const resolveOptions = deps.resolveOptions ?? defaultResolveSendOptions
  const capture = deps.capture ?? defaultCapture
  const closeSession = deps.closeSession ?? defaultCloseSession
  const now = deps.now ?? Date.now
  const mintId = deps.mintId ?? defaultMintId

  const childSessionId = `${parentSessionId}::sub-${mintId()}`
  const childConfig = { ...buildChildConfig(deps.config, def), cwd: deps.cwd }

  const ctx = toBuildContext({
    sessionId: childSessionId,
    config: childConfig,
    mcpServers: deps.mcpServers,
    now: now(),
  })
  let sendOptions = await resolveOptions(ctx)
  deps.signal?.throwIfAborted()
  // Bound the subagent: an explicit `maxTurns` from its definition wins as the
  // ai-sdk step budget; otherwise it inherits the parent's configured cap.
  if (typeof def.maxTurns === "number" && def.maxTurns > 0) {
    sendOptions.maxTurns = def.maxTurns
  }
  if (sendOptions.aiSdkMaxSteps === undefined && childConfig.aiSdkMaxSteps !== undefined) {
    sendOptions.aiSdkMaxSteps = childConfig.aiSdkMaxSteps
  }
  // Inherit the parent's read-only built-in tool execution deadline so a hung
  // file-walk tool can't stall the subagent turn until the wall-clock either.
  if (
    sendOptions.toolExecutionTimeoutMs === undefined &&
    childConfig.toolExecutionTimeoutMs !== undefined
  ) {
    sendOptions.toolExecutionTimeoutMs = childConfig.toolExecutionTimeoutMs
  }
  sendOptions = withCliDisabledMcpTools(
    withCliAutoApprovedTools(sendOptions, deps.approvedTools),
    deps.disabledMcpTools
  )
  // Hand the child the same hook engine the parent turn gets. Without this a
  // CLI subagent ran completely hook-blind: the CLI transport bypasses the
  // desktop's host-side injection, and the CLI's own `hook-runner` is wired
  // into the TUI only. Identity marks it a subagent so an `agents: "subagent"`
  // selector scopes to exactly these turns.
  const hooks = (deps.resolveHooks ?? (() => resolveCliHooksConfig({ home: deps.home })))()
  if (hasAnyHookGroup(hooks)) sendOptions.hooks = hooks
  sendOptions.agentKind = "subagent"
  sendOptions.agentRef = def.id
  // Nested delegation (depth-gated by the dispatcher): advertise the
  // `dispatch_agent` tool to the child and publish its dispatch context under
  // the child session id so a mid-run dispatch resolves its depth/chain/gate.
  if (deps.nesting) {
    if (deps.nesting.manifest) {
      sendOptions.pluginTools = [...(sendOptions.pluginTools ?? []), deps.nesting.manifest]
    }
  }

  let result: RunAndCaptureResult
  try {
    deps.signal?.throwIfAborted()
    deps.nesting?.register(childSessionId)
    deps.signal?.throwIfAborted()
    result = await capture(childSessionId, prompt, sendOptions, {
      ...(deps.signal ? { signal: deps.signal } : {}),
      // No hard wall-clock: a dispatched subagent is autonomous and may
      // legitimately run for many minutes (deep analysis, many tool legs),
      // exactly like the interactive parent turn (which passes `timeoutMs: 0`).
      // Bounding it by a 5-minute wall-clock — the `run-and-capture` default
      // that applies when `timeoutMs` is omitted — silently killed long
      // subagents. It is bounded instead by the idle watchdog below, the
      // per-tool execution deadline, and the step/turn budget.
      timeoutMs: 0,
      // Use the generous SUBAGENT idle window, not the interactive 60s. Several
      // subagents fan out concurrently over the one sidecar, so the provider gap
      // between a tool result and the next token routinely exceeds 60s under
      // load — which spuriously tripped the watchdog ("stream idle for
      // 60000ms"). Falls back to the interactive idle, then a 5-minute default.
      idleTimeoutMs:
        childConfig.subagentStreamIdleTimeoutMs ?? childConfig.streamIdleTimeoutMs ?? 300_000,
      onPermissionRequest: async (request) => {
        deps.signal?.throwIfAborted()
        if (
          deps.approvedTools.has(request.toolName) ||
          deps.approvedTools.has(approvalKey(request.toolName, request.input))
        )
          return { decision: "allow" }
        const decision = await deps.gate(request)
        deps.signal?.throwIfAborted()
        return decision
      },
      ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    })
  } finally {
    // Retire the child's dispatch context (if nesting was granted) BEFORE the
    // session, so a stale tool-call arriving after settle finds no context.
    try {
      deps.nesting?.unregister(childSessionId)
    } catch {
      // best-effort — an unregister throw must never mask the run's outcome
    }
    // Retire the child session's sidecar loop regardless of outcome.
    await closeSession(childSessionId).catch(() => undefined)
  }

  return {
    text: result.text,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.resultSubtype ? { finishReason: result.resultSubtype } : {}),
  }
}
