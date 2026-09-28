import { raceDeadline } from "../../shared/deadline.ts"
import type { HostSession, Outcome } from "../sessions/types.ts"
import type { SendOptions, Prompt } from "../../shared/wire/inbound.ts"
import type { McpServerEntry } from "../../mcp/client/types.ts"
import { errorMessage } from "../../shared/errors.ts"
import { routeClose } from "../sessions/lifecycle.ts"
import { capabilitySupported } from "../../runtimes/registry.ts"
import { isControlMethod, controlMethodCapability, controlParamError } from "./control.ts"
import { guardAnthropicRemoteMcpServers } from "../../mcp/relay/sdk-servers.ts"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

// Change a live session's permission mode in place — WITHOUT respawning the
// session (which would lose the in-process conversation). On the Anthropic path
// the SDK `Query` exposes `setPermissionMode` (streaming-input only); on both
// paths we mutate the session's `sendOptions.permissionMode` so the next tool
// gate honours the change. Unknown / closed sessions and an invalid mode are a
// no-op — a mode switch must never fault the host.
const VALID_PERMISSION_MODES = new Set([
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  // SDK 0.3.x PermissionMode also exposes `dontAsk` (deny anything not
  // pre-approved, no prompt) and `auto` (model-classifier approve/deny).
  "dontAsk",
  "auto",
])

/** A mode is effective only after the owning runtime confirms it. */
export async function routeSetMode(
  sessionsMap: Map<string, HostSession>,
  msg: { sessionId?: string; mode?: unknown },
  timeoutMs = 6000
): Promise<Outcome> {
  const { sessionId, mode } = msg
  const session = sessionsMap.get(sessionId!)
  if (!session) return { ok: false, error: "no_active_session" }
  if (typeof mode !== "string" || !VALID_PERMISSION_MODES.has(mode))
    return { ok: false, error: "invalid_permission_mode" }
  const prior = session.modeTransition ?? Promise.resolve()
  const transition = prior
    .catch(() => {})
    .then(async (): Promise<Outcome> => {
      if (sessionsMap.get(sessionId!) !== session) return { ok: false, error: "no_active_session" }
      if ((session.sendOptions?.provider ?? "anthropic") === "anthropic") {
        if (typeof session.q?.setPermissionMode !== "function")
          return { ok: false, error: "unsupported_provider" }
        const outcome = await runControlWithTimeout(
          session.q.setPermissionMode,
          session.q,
          [mode],
          timeoutMs
        )
        if (!outcome.ok) {
          // A timed-out SDK may apply the mode later. Retire that runtime so its
          // uncertain permissions cannot govern a subsequent tool call.
          if (outcome.error === "control timed out") routeClose(sessionsMap, { sessionId })
          return outcome
        }
      }
      if (sessionsMap.get(sessionId!) !== session) return { ok: false, error: "no_active_session" }
      if (session.sendOptions)
        session.sendOptions.permissionMode = mode as SendOptions["permissionMode"]
      return { ok: true, result: { mode } }
    })
  session.modeTransition = transition
  return transition
}

// Sidecar-side backstop deadline for a live-SDK control method. Deliberately a
// bit longer than the renderer's `ipc.ts` CONTROL_TIMEOUT_MS (8s): the renderer
// gives up first, and this guarantees the host's own promise never dangles
// forever if the SDK control call wedges (e.g. a provider API hang).
export const CONTROL_TIMEOUT_MS = 10_000

/**
 * Invoke a live-SDK control method with a hard deadline. The underlying SDK
 * promise cannot be cancelled, so on timeout we RESOLVE with an error and let
 * the late settlement be ignored — this frees `handleControl` instead of
 * awaiting indefinitely. Pure (no module state) so the timeout/await/throw
 * branches are unit-testable.
 *
 * @param {Function} fn the control method
 * @param {unknown} thisArg `this` for the method (the live `Query`)
 * @param {unknown[]} args positional args
 * @param {number} timeoutMs deadline in ms
 * @returns {Promise<{ ok: true, result: unknown } | { ok: false, error: string }>}
 */
export async function runControlWithTimeout<T, A extends unknown[]>(
  fn: (this: T, ...args: A) => unknown,
  thisArg: T,
  args: A,
  timeoutMs = CONTROL_TIMEOUT_MS
): Promise<Outcome> {
  const invoke = (async (): Promise<Outcome> => {
    try {
      return { ok: true, result: await fn.apply(thisArg, args) }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })()
  return raceDeadline<Outcome>(
    invoke,
    timeoutMs,
    () => ({ ok: false, error: "control timed out" }),
    { ref: true }
  )
}

/**
 * Push an additional user message into an active Anthropic streaming-input
 * query. This deliberately bypasses `handleSend`: ordinary sends retain their
 * stale-session restart protection, while an explicit steer may only target
 * the currently-owned live input stream.
 *
 * The acknowledgement means "accepted by the sidecar input queue". It does
 * not claim that an already-issued provider HTTP request was mutated; the SDK
 * consumes the message at its next supported boundary.
 *
 * @param {Map<string, any>} sessionsMap
 * @param {{ sessionId?: string, prompt?: any, priority?: string, sourceMessageId?: string }} msg
 * @returns {{ ok: true, result: { accepted: true } } | { ok: false, error: string }}
 */
export function routeSteer(
  sessionsMap: Map<string, HostSession>,
  msg: { sessionId?: string; prompt?: unknown; priority?: unknown; sourceMessageId?: unknown }
): Outcome {
  const { sessionId, prompt, priority, sourceMessageId } = msg
  const session = sessionsMap.get(sessionId!)
  if (!session) return { ok: false, error: "no_active_session" }
  if ((session.sendOptions?.provider ?? "anthropic") !== "anthropic") {
    return { ok: false, error: "unsupported_provider" }
  }
  if (typeof prompt !== "string" && !Array.isArray(prompt)) {
    return { ok: false, error: "invalid_prompt" }
  }
  if (priority !== undefined && !["now", "next", "later"].some((value) => value === priority)) {
    return { ok: false, error: "invalid_priority" }
  }
  if (sourceMessageId !== undefined && typeof sourceMessageId !== "string") {
    return { ok: false, error: "invalid_source_message_id" }
  }
  if (typeof session.pushUserMessage !== "function") {
    return { ok: false, error: "unsupported_provider" }
  }
  try {
    const accepted = session.pushUserMessage(prompt as Prompt, priority as string | undefined)
    if (accepted === false) return { ok: false, error: "input_closed" }
    session.scheduleSteerInputClose?.()
    return {
      ok: true,
      result: { accepted: true, ...(sourceMessageId ? { sourceMessageId } : {}) },
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/**
 * Decide whether a control frame must be refused, without touching the live
 * session. Returns `{ error, capability? }` or null when the frame is fine.
 *
 * Ordered cheapest-and-most-specific first, and deliberately BEFORE the
 * session lookup: whether an adapter can serve a control is a property of the
 * resolved spec, so the answer must not depend on whether a loop happens to
 * still be running. `no_active_session` and `unsupported_provider` are decided
 * afterwards by the caller, because only they need the live object.
 *
 * A session with no frozen adapter id is never capability-gated — ADR-0090
 * constraint 6 keeps the legacy queue byte-identical, and there a method the
 * runtime lacks still reports the old `unsupported_provider`.
 *
 * @param {string | undefined} adapterId  the session's frozen runtime adapter
 * @param {unknown} method
 * @param {any} params
 * @returns {{ error: string, capability?: string } | null}
 */
export function controlPreflight(
  adapterId: string | undefined,
  method: unknown,
  params?: Record<string, unknown> | null
) {
  if (!isControlMethod(method)) return { error: "unknown_method" }
  const capability = controlMethodCapability(method)
  if (adapterId && capability && !capabilitySupported(adapterId, capability)) {
    return { error: "capability_error", capability }
  }
  const paramError = controlParamError(method, params)
  return paramError ? { error: paramError } : null
}

/**
 * Drive a live session's SDK `Query` control method and reply with a
 * `control_response` correlated by `requestId`. The allowlist and the
 * param→positional mapping live in `dispatch/control.mjs`, generated from
 * `protocol/agent-control-methods.json`.
 *
 * These methods are streaming-input-only and Anthropic-path only, so the
 * ai-sdk rail's `q` simply lacks them. Four rejections, in the order they can
 * be decided — cheapest and most specific first:
 *
 *   `unknown_method`     the method is not on the allowlist at all
 *   `capability_error`   the session's FROZEN adapter cannot serve it
 *   `no_active_session`  nothing live to call
 *   `unsupported_provider` the live query object has no such method
 *
 * The capability check comes before the session lookup on purpose: the answer
 * is a property of the resolved spec, not of whether a loop happens to still
 * be running, so it must not depend on timing. It applies only to sessions
 * carrying a frozen spec — ADR-0090 constraint 6 keeps the legacy queue
 * byte-identical, and there a missing method still reports the old
 * `unsupported_provider`.
 *
 * Never throws: a control request must never fault the host (mirrors
 * handleSetMode / handleInterrupt).
 */
export function guardedControlParams(
  method: string,
  params: Record<string, unknown>,
  sendOptions: SendOptions = {}
) {
  if (method === "setMcpServers") {
    if (sendOptions.toolSurface === "none" && Object.keys(params.servers as object).length)
      throw new Error("tool surface is disabled")
    // Server names enter model-visible tool names; credentials remain transport-only.
    if (!hasNoLeakingPiiDeep(Object.keys(params.servers as object)))
      throw new Error("control blocked by the PII gate")
    return {
      ...params,
      servers: guardAnthropicRemoteMcpServers(params.servers as Record<string, McpServerEntry>, {
        permissionPromptToolName: sendOptions.claudeAgentSdk?.permissionPromptToolName,
      }),
    }
  }
  if (
    (method === "applyFlagSettings" || method === "updateSettings") &&
    !hasNoLeakingPiiDeep(params.settings)
  )
    throw new Error("control blocked by the PII gate")
  return params
}
