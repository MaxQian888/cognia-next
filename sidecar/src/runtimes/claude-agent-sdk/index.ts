import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { DispatchParams, RuntimeDeps } from "./runtime-types.ts"
import type { PendingApproval } from "../../policy/permission/approval.ts"
import type { PendingPluginToolCalls } from "../../tools/plugin/server.ts"
import type { PendingPluginHooks } from "../../hooks/kernel/types.ts"

import { createToolSessionContext } from "../../tools/session.ts"
// Anthropic dispatch: thin wrapper around `@anthropic-ai/claude-agent-sdk`'s
// `query()` plus the in-process MCP servers (cognia-tools + a2ui-bridge).
//
// Returns the `Session` shape consumed by `claude-host.mjs`:
//   { q, pushUserMessage, closeInput, pendingApprovals }
//
// Behaviour parity: this module is a straight extraction of what the
// pre-port `startSession` did when no provider field was set. The protocol
// emitted on stdout is unchanged (sdk_session_id / event / permission_request
// / session_ended).

import { query } from "@anthropic-ai/claude-agent-sdk"
import { traceAsyncIterable } from "../../platform/telemetry/index.ts"

import { makeInputStream } from "../../shared/input-stream.ts"

import { createCallLedgerGate } from "../common/call-ledger-gate.ts"

import { createDoomLoopGuard } from "../../policy/doom-loop.ts"
import { createStderrLogSink, buildMcpLogEvent } from "../../mcp/client/log.ts"
import { createMcpAutoReconnector } from "../../mcp/client/auto-reconnect.ts"

import { warmPool } from "./warm-pool.ts"

import { buildToolSurface } from "./tool-surface.ts"
import { buildAnthropicOptions } from "./options.ts"
import { createAnthropicSession } from "./session.ts"
import { startAnthropicPump } from "./pump.ts"
export { enforceAnthropicToolSurface } from "./tool-surface.ts"
export { anthropicPluginToolBridgeOptions } from "./plugin-bridge.ts"
export { drainPendingRoundTrips } from "./session.ts"
export function dispatchAnthropic(
  { sessionId, firstPrompt, sendOptions, emit, log, hostRpc }: DispatchParams,
  runtime: RuntimeDeps = {}
) {
  const inputStream = makeInputStream<SDKUserMessage>()
  // MCP server output capture. The Agent SDK forwards the spawned claude-code
  // subprocess's stderr — which carries every stdio MCP server's diagnostic
  // output — through the `stderr` option wired into `options` below. Each line
  // becomes an `mcp_log` event the renderer's MCP log panel renders. Before
  // this the output had no sink ("without stderr access") and was silently lost.
  const mcpStderrSink = createStderrLogSink({
    sessionId,
    emit: (frame) => emit({ ...frame }),
    source: "stderr",
  })
  const pendingApprovals = new Map<string, PendingApproval>()
  /**
   * Plugin tool calls awaiting a `plugin_tool_response` from the renderer.
   * Keyed by `toolUseId`. Drained by `claude-host.mjs` when a response
   * arrives over stdin. See `sidecar/src/tools/plugin/server.ts`.
   */
  const pendingPluginToolCalls: PendingPluginToolCalls = new Map()
  // `{ type: "plugin" }` lifecycle-hook handlers round-trip through the renderer
  // the same way plugin tools do; `claude-host.mjs` settles this map from the
  // `plugin_hook_response` frame. See `dispatch/plugin-hook-exec.mjs` for why
  // `host_rpc` cannot be used for this.
  const pendingPluginHookCalls: PendingPluginHooks = new Map()

  // Shared with the ai-sdk path's permission gate — see src/policy/doom-loop.ts.
  const doomGuard = createDoomLoopGuard()

  // Router + Fusion envelope mode (ADR-0188). Active only for a send carrying a
  // ledger stamp; the SDK's own model fallback and hidden transport retries are
  // off for such a turn, and every tool use re-checks the run with the renderer.
  const ledgerGate = createCallLedgerGate({
    ledger: sendOptions.ledger?.mode === "envelope" ? sendOptions.ledger : null,
    sessionId,
    emit,
    log,
    remoteExecutionContext: sendOptions.remoteExecutionContext,
  })
  const sdkFallbackModel = ledgerGate.active
    ? undefined
    : (sendOptions.execution?.modelBindings?.fast ?? sendOptions.fallbackModel)
  const sdkMaxBudgetUsd =
    ledgerGate.active && typeof sendOptions.ledger?.envelopeMaxBudgetUsd === "number"
      ? Math.min(sendOptions.maxBudgetUsd ?? Infinity, sendOptions.ledger.envelopeMaxBudgetUsd)
      : sendOptions.maxBudgetUsd
  /** Late-bound so a ledger refusal inside a hook can stop the query built below. */
  let interruptForLedger = () => {}

  const toolSession = createToolSessionContext({ sendOptions, log, hostRpc, sessionId })
  const surface = buildToolSurface({
    sendOptions,
    sessionId,
    emit,
    log,
    toolSession,
    pendingPluginToolCalls,
  })
  const { pluginToolNameAliases } = surface
  const options = buildAnthropicOptions({
    sendOptions,
    sessionId,
    emit,
    log,
    hostRpc,
    mcpStderrSink,
    ledgerGate,
    sdkFallbackModel,
    sdkMaxBudgetUsd,
    toolSession,
    pendingApprovals,
    pendingPluginHookCalls,
    doomGuard,
    interruptForLedger: () => interruptForLedger(),
    surface,
  })
  // Prewarm (ADR-0090 Stage 4): a warm subprocess has already spawned and run
  // its initialize handshake, which is most of the latency before the first
  // token. Claiming one is safe only when every input the handshake baked in
  // matches — `warmFingerprint` is what decides that, and it declines rather
  // than guesses. A miss is an ordinary cold spawn.
  const pool = runtime.pool ?? warmPool({ log })
  const prewarmEnabled = sendOptions.claudeAgentSdk?.prewarm?.enabled === true
  const claimed = prewarmEnabled ? pool.claim(sendOptions, options) : null
  const rawQuery = claimed
    ? claimed.query(inputStream.iterable)
    : (runtime.query ?? query)({ prompt: inputStream.iterable, options })
  // Warm the NEXT subprocess of this shape. Deliberately after the claim and
  // fire-and-forget: the options are only fully known at send time, so a pool
  // entry can only ever be built from a previous send just like this one.
  if (prewarmEnabled) {
    void pool.prewarm(sendOptions, options).then((declined) => {
      if (declined) {
        log("warn", `prewarm skipped: ${declined}`)
        emit({ type: "sdk_option_warning", sessionId, message: `Prewarm skipped: ${declined}` })
      }
    })
  }
  const q = traceAsyncIterable(
    "gen_ai.invoke_agent",
    sendOptions.traceparent,
    {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": sendOptions.model ?? "unknown",
      "cognia.session.id": sessionId,
    },
    rawQuery,
    // Repatriate the span to the renderer over the same event channel the
    // stream already uses, so a default install with no OTLP collector still
    // records what the sidecar did instead of leaving a hole in the waterfall.
    {
      emit: (frame) => emit({ ...frame }),
      sessionId,
      operationName: "invoke_agent",
      providerName: "anthropic",
    }
  )

  // A ledger refusal inside the PreToolUse hook stops the query: the SDK must
  // not make another model call on a run the ledger closed.
  interruptForLedger = () => {
    void Promise.resolve()
      .then(() => q.interrupt())
      .catch((err) => log("warn", `ledger interrupt failed: ${err?.message ?? err}`))
  }

  // First-connection self-healing: the SDK's `system/init` event reports each
  // MCP server's connect status; a server that failed its FIRST connect (cold
  // npx install, waking remote endpoint) is auto-reconnected once instead of
  // staying failed until the user finds the reconnect button. `needs-auth`
  // servers are left alone (reconnecting can't mint a token).
  const mcpAutoReconnect = createMcpAutoReconnector({
    reconnect: (name) => q.reconnectMcpServer!(name),
    log,
    emitMcpLog: ({ level, message, server, source }) =>
      emit({ ...buildMcpLogEvent({ sessionId, ts: Date.now(), level, message, server, source }) }),
  })

  const { session, state } = createAnthropicSession({
    q,
    inputStream,
    doomGuard,
    sessionId,
    emit,
    ledgerGate,
    pendingApprovals,
    pendingPluginToolCalls,
    pendingPluginHookCalls,
    sendOptions,
  })
  session.pushUserMessage(firstPrompt)
  startAnthropicPump({
    sessionId,
    sendOptions,
    emit,
    log,
    q,
    mcpAutoReconnect,
    pluginToolNameAliases,
    session,
    state,
    mcpStderrSink,
    toolSession,
  })
  return session
}
