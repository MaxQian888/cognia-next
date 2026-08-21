/**
 * `{ type: "plugin" }` lifecycle-hook handler — the settings.json ⇄ plugin bridge.
 *
 * A user writes a hook group in `settings.json` naming a plugin and one of its
 * hook handlers; the plugin's handler is a normal in-process TS/Python callback
 * living in the renderer, so the sidecar has to round-trip to reach it.
 *
 * ## Why not `host_rpc`
 *
 * `host_rpc` looks like the natural channel and is NOT: `answer_host_rpc` in
 * `src-tauri/src/claude/sidecar.rs` is deliberately terminal — it is answered in
 * Rust and never forwarded to the renderer, and it only dispatches `jobs.*` plus
 * the agent-session-store methods. That is why `sidecar/dispatch/pre-compact-hook.mjs`
 * has always fallen back instead of reaching the plugin's `onPreCompact`.
 *
 * This module therefore mirrors the channel that DOES reach the renderer, the
 * `plugin_tool_exec` round-trip:
 *
 *   1. sidecar emits `{ type: "plugin_hook_exec", sessionId, execId, pluginId, hookId, payload }`
 *   2. Rust's default branch forwards the frame on `SIDECAR_EVENT` (no special
 *      case needed — unknown frames pass through)
 *   3. the renderer resolves the handler through the plugin hook registry, runs
 *      it, and calls `claude_plugin_hook_response`
 *   4. Rust writes `{ type: "plugin_hook_response", sessionId, execId, result?, error? }`
 *      to the sidecar's stdin
 *   5. `agent-host.mjs` settles the pending promise here
 *
 * ## Failure policy
 *
 * Fail OPEN, always. A missing renderer (headless), a disabled plugin, a timeout
 * or a throwing handler all resolve to a warning, never a block — a hook bridge
 * that cannot be reached must not lock a user out of their own agent. The one
 * exception is an explicit `{ block }` decision the plugin itself returned.
 */

/** Round-trip budget. Deliberately short: this can sit in the PreToolUse path. */
export const PLUGIN_HOOK_TIMEOUT_MS = 5_000

/**
 * Sentinel `pluginId` meaning "fan out to every plugin contributing this hook"
 * rather than targeting one. Used by the host's own hook seams (compaction),
 * never by a user's settings.json entry — a user names a specific plugin.
 */
export const PLUGIN_HOOK_BROADCAST = "*"

/**
 * Register a pending round-trip and return a promise for its response.
 * Resolves `{ timedOut: true }` rather than rejecting so callers have one shape.
 *
 * @param {Map<string, {resolve: (r: any) => void}>} pending
 * @param {string} execId
 * @param {number} [timeoutMs]
 */
export function awaitPluginHookResponse(pending, execId, timeoutMs = PLUGIN_HOOK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pending.delete(execId)
      resolve(value)
    }
    const timer = setTimeout(() => finish({ timedOut: true }), Math.max(1, timeoutMs))
    // Do not keep the sidecar process alive for a hook that never answers.
    if (typeof timer?.unref === "function") timer.unref()
    pending.set(execId, { resolve: finish })
  })
}

/**
 * Map a renderer response onto the shared hook-outcome shape used by every
 * other handler kind in `agent-hooks.mjs`.
 */
export function pluginHookOutcome(response, label) {
  if (!response || response.timedOut) {
    return { warning: `plugin hook ${label} timed out` }
  }
  if (response.error) {
    return { warning: `plugin hook ${label} failed: ${String(response.error)}` }
  }
  const result = response.result
  if (!result || typeof result !== "object") return {}

  // Only an explicit decision from the plugin can block. Everything else is
  // observational, matching what a command handler exiting 0 can express.
  // `pluginResult` carries the raw return for the host's own seams (the
  // compaction hook needs `skipCompaction` / `customStrategy`, which have no
  // equivalent in the settings.json decision vocabulary).
  const out = { pluginResult: result }
  const block =
    typeof result.block === "string"
      ? result.block
      : result.action === "deny" || result.decision === "block"
        ? (result.reason ?? result.message ?? `blocked by ${label}`)
        : undefined
  if (block) out.block = String(block)
  const context = result.additionalContext ?? result.context
  if (typeof context === "string" && context.length > 0) out.additionalContext = context
  return out
}

/**
 * Run one `{ type: "plugin" }` handler. Never throws.
 *
 * @param {{pluginId?: string, hookId?: string, timeout?: number}} handler
 * @param {string} payloadJson  the serialized hook payload
 * @param {{emit?: Function, sessionId?: string, pendingPluginHookCalls?: Map<string, any>, newId?: () => string}} deps
 */
export async function runPluginHookHandler(handler, payloadJson, deps = {}) {
  const pluginId = typeof handler?.pluginId === "string" ? handler.pluginId : ""
  const hookId = typeof handler?.hookId === "string" ? handler.hookId : ""
  const label = `${pluginId || "?"}:${hookId || "?"}`
  if (!pluginId || !hookId) {
    return { warning: `plugin hook handler is missing pluginId/hookId (${label})` }
  }
  const pending = deps.pendingPluginHookCalls
  if (!pending || typeof deps.emit !== "function") {
    // Headless host, or a rail with no renderer attached. Fail open.
    return { warning: `plugin hook ${label} has no renderer to run on` }
  }

  let payload
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    payload = {}
  }

  const execId = typeof deps.newId === "function" ? deps.newId() : `hook_${pending.size}_${label}`
  const timeoutMs =
    typeof handler.timeout === "number" && handler.timeout > 0
      ? handler.timeout * 1000
      : PLUGIN_HOOK_TIMEOUT_MS
  const promise = awaitPluginHookResponse(pending, execId, timeoutMs)
  try {
    deps.emit({
      type: "plugin_hook_exec",
      sessionId: deps.sessionId,
      execId,
      pluginId,
      hookId,
      payload,
    })
  } catch (e) {
    pending.delete(execId)
    return { warning: `plugin hook ${label} could not be dispatched: ${e?.message ?? e}` }
  }
  return pluginHookOutcome(await promise, label)
}
