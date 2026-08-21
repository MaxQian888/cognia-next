/**
 * Dynamic compaction seam — wires the existing `dispatchPreCompact` plugin hook
 * result back into the sidecar's compaction path via `host_rpc`.
 *
 * Before ADR-0090 Phase 9 (this module), the plugin `onPreCompact` hook was
 * registered but never wired to a live trigger: the renderer-side dispatch
 * existed but had no call site because the sidecar (where compaction runs)
 * cannot import `lib/`. This module bridges that gap through the existing
 * `host_rpc` channel.
 *
 * ## Protocol
 *
 * This module originally documented a `host_rpc` round-trip to the renderer.
 * That never worked: `answer_host_rpc` in `src-tauri/src/claude/sidecar.rs` is
 * deliberately TERMINAL — answered in Rust, never forwarded to the renderer —
 * and it only dispatches `jobs.*` plus the agent-session-store methods. There
 * has never been a `preCompact` method, so every call errored and fell back,
 * which is why `onPreCompact` was marked dormant in `types/plugin/plugin-hooks.ts`.
 *
 * It now rides the same renderer round-trip the `{ type: "plugin" }` hook
 * handler uses (`./plugin-hook-exec.mjs`):
 *   1. sidecar emits { type: "plugin_hook_exec", sessionId, execId,
 *      pluginId: "*", hookId: "onPreCompact", payload }
 *   2. Rust's default branch forwards it on SIDECAR_EVENT (no special case)
 *   3. the renderer dispatches to every plugin and answers
 *   4. Rust writes { type: "plugin_hook_response", … } to the sidecar stdin
 *   5. sidecar reads the result and adjusts the compaction plan accordingly
 *
 * Wire params match the existing `PreCompactContext`:
 *   { sessionId, messageCount, tokenCount, compressionRatio }
 *
 * Wire result matches the existing `PreCompactResult`:
 *   { skipCompaction?, contextToInject?, customStrategy? }
 *
 * Fallback: when `host_rpc` times out, errors, or is unavailable (headless), the
 * compaction falls back to the already-selected built-in strategy — the plugin
 * decision is NEVER required for compaction to proceed.
 */

// The timeout for the pre-compact host callback. Plugins that take too long
// lose their vote rather than blocking the model turn indefinitely.
export const PRE_COMPACT_TIMEOUT_MS = 5_000

/**
 * @typedef {import("../../types/plugin/plugin-hooks").PreCompactContext} PreCompactContext
 * @typedef {import("../../types/plugin/plugin-hooks").PreCompactResult} PreCompactResult
 */

/**
 * @typedef {object} PreCompactDecision
 * @property {boolean} skip - true iff a plugin requested skipping compaction
 * @property {string | undefined} contextToInject - bounded context to prepend to the summary
 * @property {string | undefined} strategyOverride - mapped strategy name
 * @property {"plugin" | "fallback"} source - whether the decision came from a plugin or fell back
 */

/** Max length for injected context (prevents plugin abuse / unbounded growth). */
const MAX_INJECT_LENGTH = 4096

/**
 * Map the legacy `customStrategy` values from PreCompactResult to the
 * CompressionStrategy names the sidecar's planStrategy() accepts.
 *
 * The legacy `"aggressive" | "moderate" | "minimal"` enum predates the unified
 * strategy registry. We map them to the closest built-in strategies and emit a
 * deprecation event. New plugins should use `strategyId` from the registry.
 *
 * @param {string | undefined} legacy
 * @returns {string | undefined}
 */
function mapLegacyStrategy(legacy) {
  if (!legacy) return undefined
  switch (legacy) {
    case "aggressive":
      return "recursive"
    case "moderate":
      return "selective"
    case "minimal":
      return "sliding-window"
    default:
      return undefined
  }
}

/**
 * Validate and clamp a PreCompactResult from the host_rpc callback.
 * Returns a safe decision object regardless of what the plugin returned.
 *
 * @param {unknown} raw
 * @returns {PreCompactDecision}
 */
export function validatePreCompactResult(raw) {
  const fallback = {
    skip: false,
    contextToInject: undefined,
    strategyOverride: undefined,
    source: "fallback",
  }
  if (!raw || typeof raw !== "object") return fallback

  const result = /** @type {Record<string, unknown>} */ (raw)
  const skip = result.skipCompaction === true
  let contextToInject = undefined
  if (typeof result.contextToInject === "string" && result.contextToInject.length > 0) {
    contextToInject = result.contextToInject.slice(0, MAX_INJECT_LENGTH)
  }
  const strategyOverride = mapLegacyStrategy(
    /** @type {string|undefined} */ (result.customStrategy)
  )

  return { skip, contextToInject, strategyOverride, source: "plugin" }
}

/**
 * Call the host's preCompact hook and return the decision.
 * Falls back gracefully on timeout, error, or unavailability.
 *
 * @param {object} hostRpc - retained for call-site compatibility; unused
 * @param {PreCompactContext} context
 * @param {{ log?: (level: string, msg: string) => void, pluginHookBridge?: (req: {hookId: string, payload: unknown, timeoutMs?: number}) => Promise<unknown> }} [opts]
 * @returns {Promise<PreCompactDecision>}
 */
export async function queryPreCompactDecision(hostRpc, context, opts = {}) {
  const log = opts.log ?? (() => {})
  const fallback = {
    skip: false,
    contextToInject: undefined,
    strategyOverride: undefined,
    source: "fallback",
  }

  // `hostRpc` is kept in the signature for call-site compatibility but is no
  // longer the transport — see the protocol note above. The renderer bridge is
  // supplied through `opts`; without it (headless, or a rail with no renderer)
  // compaction proceeds on its built-in strategy exactly as before.
  const bridge = opts.pluginHookBridge
  if (typeof bridge !== "function") {
    return fallback
  }

  try {
    const raw = await bridge({
      hookId: "onPreCompact",
      payload: context,
      timeoutMs: PRE_COMPACT_TIMEOUT_MS,
    })
    const decision = validatePreCompactResult(raw)
    if (decision.skip) {
      log("info", `preCompact plugin requested skip (session ${context.sessionId})`)
    }
    if (decision.contextToInject) {
      log("info", `preCompact plugin injecting ${decision.contextToInject.length} chars`)
    }
    if (decision.strategyOverride) {
      log("info", `preCompact plugin overriding strategy to "${decision.strategyOverride}"`)
    }
    return decision
  } catch (err) {
    // Timeout / unavailable / renderer not connected — all fall back silently.
    log("warn", `preCompact host callback failed: ${err?.message ?? err}; using built-in strategy`)
    return fallback
  }
}
