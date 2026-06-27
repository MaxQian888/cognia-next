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
 * Depth policy: the child's send options deliberately do NOT re-surface the
 * `dispatch_agent` tool (that is appended only on the main session), so a
 * subagent runs as a leaf and cannot itself spawn — a single, safe level of
 * delegation rather than unbounded nesting.
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
import type { McpServer, SendOptions } from "@/lib/claude/types"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

import { type ResolvedConfig } from "../config/schema"
import { toBuildContext } from "../config/to-build-context"
import { type PermissionResponder } from "./permission-gate"
import { withCliAutoApprovedTools, withCliDisabledMcpTools } from "./tool-suppression"

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
  // ── Injected seams (tests) ──────────────────────────────────────────────────
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
  const resolveOptions = deps.resolveOptions ?? defaultResolveSendOptions
  const capture = deps.capture ?? defaultCapture
  const closeSession = deps.closeSession ?? defaultCloseSession
  const now = deps.now ?? Date.now
  const mintId = deps.mintId ?? defaultMintId

  const childSessionId = `${parentSessionId}::sub-${mintId()}`
  const childConfig = buildChildConfig(deps.config, def)

  const ctx = toBuildContext({
    sessionId: childSessionId,
    config: childConfig,
    mcpServers: deps.mcpServers,
    now: now(),
  })
  let sendOptions = await resolveOptions(ctx)
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

  let result: RunAndCaptureResult
  try {
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
      onPermissionRequest: deps.gate,
      ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    })
  } finally {
    // Retire the child session's sidecar loop regardless of outcome.
    await closeSession(childSessionId).catch(() => undefined)
  }

  return {
    text: result.text,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.resultSubtype ? { finishReason: result.resultSubtype } : {}),
  }
}
