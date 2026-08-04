// Cognia Claude sidecar: bridges Tauri (parent) <-> @anthropic-ai/claude-agent-sdk
// Protocol: JSON-lines over stdio.
//
// Inbound (parent -> sidecar) on stdin:
//   { type: "send",                sessionId, prompt, options? }
//     prompt: string | Array<{ type: "text", text } | { type: "image", source }>
//     options.turnId: per-send turn id. Echoed on every session-scoped outbound
//       event (see `makeWrappedEmit`), bound to the loop live when the turn
//       started, so the parent can tell this turn's events apart from a
//       superseded loop's late ones. Absent ⇒ events go out unstamped.
//   { type: "interrupt",           sessionId }
//   { type: "permission_response", sessionId, requestId, decision: "allow"|"allow_always"|"deny" }
//   { type: "plugin_tool_response", sessionId, toolUseId, result?, error? }
//   { type: "tool_result_decision", sessionId, reviewId, updatedToolOutput? }
//   { type: "close",               sessionId }
//
// Outbound (sidecar -> parent) on stdout, one JSON object per line. Every
// session-scoped message below also carries `turnId` when the send supplied one:
//   { type: "event",              sessionId, event: SDKMessage }
//   { type: "permission_request", sessionId, requestId, toolName, input, title?, displayName?, description? }
//   { type: "permission_interrupted", sessionId, requestId, reason }
//     — a pending permission_request whose waiter died (turn aborted / session
//       closed / teardown drain). The SDK already received a deny; the renderer
//       marks the approval "interrupted" instead of silently dropping it.
//   { type: "tool_result_review", sessionId, reviewId, toolUseId, toolName, result, isError }
//   { type: "plugin_tool_exec",   sessionId, toolUseId, name, args }
//   { type: "session_ended",      sessionId, result?: SDKResultMessage, error?: string }
//   { type: "ready",              sdkVersion?, sidecarVersion?, builtinToolsCount? }
//   { type: "log",                level, message }

// Side-effect import — must come first so the global fetch is patched
// before the Claude agent SDK loads. The interceptor emits a `usage_headers`
// event for every response on `api.anthropic.com`, which the renderer's
// usage-collector subscribes to (Phase 4a of the Claude subscription ADR).
import "./fetch-interceptor.mjs"
import { initializeTelemetry, shutdownTelemetry } from "./telemetry.mjs"

initializeTelemetry()
process.once("beforeExit", () => {
  void shutdownTelemetry()
  // Warm subprocesses are real processes with no parent watching them once we
  // go away — dropping the pool without closing would leave them running.
  resetWarmPool()
})

import readline from "node:readline"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { dispatch } from "./dispatch/index.mjs"
import {
  capabilityError,
  capabilitySupported,
  commandSupported,
} from "./dispatch/runtime-adapter.mjs"
import { createEnvelopeEmitter } from "./dispatch/event-envelope.mjs"
import { sendExpectsStructuredOutput } from "./dispatch/claude-sdk-options.mjs"
import { sessionStoreFromSendOptions } from "./dispatch/session-store.mjs"
import { handleSessionApi } from "./dispatch/session-api.mjs"
import { resetWarmPool } from "./dispatch/prewarm.mjs"
import {
  isControlMethod,
  controlArgs,
  controlMethodCapability,
  controlParamError,
  buildControlResponse,
} from "./dispatch/control.mjs"
import { createFeatureCallHandler } from "./dispatch/feature-call.mjs"
import { createHostRpc } from "./host-rpc.mjs"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

// Resolve sidecar + SDK versions for the `ready` payload. createRequire is
// used so we can read package.json without taking JSON-import dependency on
// runtime flags. Best-effort — failures degrade to `undefined`.
const _require = createRequire(import.meta.url)
function readVersionInfo() {
  let sdkVersion
  let sidecarVersion
  try {
    sdkVersion = _require("@anthropic-ai/claude-agent-sdk/package.json").version
  } catch {
    sdkVersion = undefined
  }
  try {
    sidecarVersion = _require("./package.json").version
  } catch {
    sidecarVersion = undefined
  }
  return { sdkVersion, sidecarVersion }
}

// ---- IO helpers -----------------------------------------------------------

// Verbose logging gate. Set COGNIA_SIDECAR_VERBOSE=1 (or "true") in the Tauri
// parent's env to bump the sidecar's stderr verbosity. Honoured by `logv`
// below; the JSON-line protocol on stdout is unaffected.
const VERBOSE = (() => {
  const raw = process.env.COGNIA_SIDECAR_VERBOSE
  return raw === "1" || raw === "true"
})()

function logv(message) {
  if (!VERBOSE) return
  process.stderr.write(`[sidecar:verbose] ${message}\n`)
}

function emit(payload) {
  try {
    process.stdout.write(JSON.stringify(payload) + "\n")
  } catch (err) {
    // Last-resort logging — stderr is captured by Tauri but not used as a protocol channel.
    process.stderr.write(`[sidecar] failed to emit: ${err?.message ?? err}\n`)
  }
}

function log(level, message) {
  emit({ type: "log", level, message })
}

const featureCalls = createFeatureCallHandler({ emit })

// Direct request/response channel to the Rust host, answered in
// `src-tauri/src/claude/sidecar.rs` without touching the renderer. Background
// jobs ride this so they work identically on desktop, headless, and remote.
const hostRpc = createHostRpc({ emit })

// ---- Per-session state ----------------------------------------------------

/**
 * @typedef Session
 * @property {import("@anthropic-ai/claude-agent-sdk").Query} q
 * @property {(msg: any) => void} pushUserMessage  push next user turn into the streaming input
 * @property {() => void} closeInput               signal end-of-input to the SDK
 * @property {Map<string, {resolve: (r: any) => void}>} pendingApprovals
 * @property {Map<string, {resolve: (r: any) => void}>} [pendingPluginToolCalls]
 */

/** @type {Map<string, Session>} */
const sessions = new Map()

// ---- Session lifecycle ----------------------------------------------------

/**
 * Wrap the dispatcher's emitter so session lifecycle events retire the entry
 * from `sessions` without each dispatcher having to know about the map. The
 * deletion policy is the crux of multi-turn context retention, so it lives in
 * one tested place. Exported for the co-located lifecycle test.
 *
 * Also stamps the parent-bound event with the id of the turn this loop is
 * serving (`turnRef.id`). The ref is per-LOOP and is only advanced by
 * `handleSend` for the session object that is still live, so a superseded loop's
 * late events keep carrying their OWN (old) turn id rather than being stamped
 * with the replacement's — which is the whole point: the renderer discards them.
 *
 * @param {(msg: any) => void} emitFn  forward an event to the parent (stdout)
 * @param {Map<string, any>} sessionsMap
 * @param {string} sessionId
 * @param {(() => any) | undefined} getOwner
 * @param {{ id?: string } | undefined} turnRef  mutable per-loop current turn id
 */
export function makeWrappedEmit(emitFn, sessionsMap, sessionId, getOwner, turnRef) {
  // Retire the map entry only when it still points at THIS session. After a
  // close-and-restart (see `handleSend` / `restartReason`) the OLD loop can emit
  // a late `session_ended` / `session_closed` for the same id — without this
  // identity check it would evict the freshly-registered replacement and strand
  // the new turn. `getOwner` is wired by `startSession`; when absent (unit
  // tests) or not yet resolved we fall back to the plain id match.
  const ownsEntry = () => {
    if (!getOwner) return true
    const owner = getOwner()
    return owner == null || sessionsMap.get(sessionId) === owner
  }
  return (msg) => {
    // `session_closed` is an INTERNAL lifecycle signal from a multi-turn
    // dispatcher (ai-sdk) — its persistent loop has genuinely ended (input
    // closed or fatal error). It never goes on the wire; it just retires the
    // session entry. Intercept before forwarding.
    if (msg && msg.type === "session_closed" && msg.sessionId === sessionId) {
      if (ownsEntry()) sessionsMap.delete(sessionId)
      return
    }
    // Stamp the turn id this loop is currently serving. Only session-scoped
    // messages carry one — `ready` / `log` go out through the raw `emit`, never
    // this wrapper. A turn-less send (older parent) leaves the field absent, and
    // the renderer treats absence as "can't tell" and keeps the event.
    const turnId = turnRef?.id
    emitFn(turnId && msg && typeof msg === "object" ? { ...msg, turnId } : msg)
    if (msg && msg.type === "session_ended" && msg.sessionId === sessionId) {
      // A multi-turn dispatcher (ai-sdk) keeps ONE live loop across turns and
      // accumulates conversation context in-process. A per-turn `session_ended`
      // must NOT tear it down — doing so dropped history every turn for every
      // non-Anthropic provider (and orphaned the loop). Such sessions are
      // removed only on `session_closed` (above) or an explicit `handleClose`.
      // Single-turn dispatchers (Anthropic, which rebuilds context via SDK
      // `resume`) are still cleaned up on `session_ended`.
      if (ownsEntry() && !sessionsMap.get(sessionId)?.multiTurn) {
        sessionsMap.delete(sessionId)
      }
    }
  }
}

/**
 * Build the `createEnvelopeEmitter` arguments for a send, or `null` when this
 * session carries no frozen execution spec.
 *
 * Split out of {@link startSession} so the mapping from send options to emitter
 * configuration is reachable by a test. It is pure, and every field it derives
 * is a defaulting decision that used to be invisible.
 *
 * @param {{ sessionId: string, sendOptions: any, turnRef: { id?: string }, emit: (msg: any) => void }} args
 */
export function envelopeEmitterParams({ sessionId, sendOptions, turnRef, emit }) {
  const execution = sendOptions?.execution
  if (!execution) return null
  return {
    sessionId,
    runId: execution.identity?.runId ?? sessionId,
    attemptId: execution.identity?.attemptId ?? "a1",
    parentRunId: execution.identity?.parentRunId,
    hostRef: execution.hostRef ?? "desktop-sidecar",
    runtime: execution.runtimeAdapter,
    turnRef,
    // Read once per loop, unlike `turnRef` which `handleSend` advances: only
    // the Claude rail supports `outputFormat`, and that rail restarts the
    // session on every send (`session_ended` evicts a non-multiTurn session),
    // so this emitter never outlives the options it was built from. A
    // multi-turn rail that later gains structured output would need a ref.
    expectStructuredOutput: sendExpectsStructuredOutput(sendOptions),
    emit,
  }
}

function startSession(sessionId, firstPrompt, sendOptions = {}) {
  // Wired after `dispatch` returns so the wrapped emitter can verify it still
  // owns the map entry before retiring it (defends against a superseded old
  // loop evicting this replacement — see `makeWrappedEmit`).
  const ownerRef = { session: null }
  // One ref per loop. `handleSend` advances it for later turns on THIS session;
  // a replacement loop gets its own, so this one keeps stamping its old id.
  const turnRef = { id: sendOptions?.turnId }
  // ADR-0090 Phase 3: sessions carrying a frozen execution spec ALSO emit
  // canonical `agent_event` envelopes (additive dual channel); legacy
  // sessions pay nothing.
  const emitterParams = envelopeEmitterParams({ sessionId, sendOptions, turnRef, emit })
  const baseEmit = emitterParams ? createEnvelopeEmitter(emitterParams) : emit
  const wrappedEmit = makeWrappedEmit(
    baseEmit,
    sessions,
    sessionId,
    () => ownerRef.session,
    turnRef
  )
  const session = dispatch({
    sessionId,
    firstPrompt,
    sendOptions,
    emit: wrappedEmit,
    log,
    hostRpc,
  })
  if (!session) return null
  ownerRef.session = session
  session.turnRef = turnRef
  session.runtimeAdapterId = emitterParams?.runtime
  sessions.set(sessionId, session)
  return session
}

// ---- Inbound command handling --------------------------------------------

/**
 * Decide whether an already-registered session must be torn down and restarted
 * for an incoming `send`, instead of pushing the prompt into the live session.
 * Returns a short reason string (for the log line) or `null` to keep the
 * session and `pushUserMessage`. Exported for the co-located unit test.
 *
 * The crux is symmetry across both dispatch paths — a `send` arriving for a
 * session whose previous turn never cleanly ended (typically a timeout whose
 * best-effort interrupt couldn't break a wedged provider stream) must NOT push
 * the prompt into a stuck session: on the ai-sdk path it would queue behind the
 * dead turn; on the Anthropic path it would push into a query the SDK has
 * already abandoned. Either way the recovery prompt ("continue") would hang and
 * the renderer would just time out again, forever.
 *
 * @param {{ q?: { active?: unknown }, multiTurn?: unknown, sendOptions?: { cwd?: string, provider?: string } }} existing
 * @param {{ cwd?: string, provider?: string } | undefined} options
 * @returns {string | null}
 */
export function restartReason(existing, options) {
  // Working directory changed — the SDK must respawn to pick up the new cwd.
  if (options?.cwd !== undefined && options.cwd !== existing.sendOptions?.cwd) {
    return "cwd changed"
  }
  // Provider changed — the live session is on the WRONG dispatch path
  // (Anthropic single-turn `query()` vs the ai-sdk multi-turn loop), so its `q`
  // can't serve the new provider and an in-place `setModel` doesn't apply.
  // Respawn so the next turn re-dispatches on the new provider's runner. A
  // same-provider MODEL change is NOT a restart trigger — that's handled live
  // via `setModel` (Anthropic `Query.setModel` / the ai-sdk `q.setModel`),
  // which preserves the conversation. Default the provider on both sides so the
  // implicit "anthropic" never reads as a change. `options.provider` is only set
  // on a real `send` (the model picker also closes explicitly on a provider
  // switch); when absent we keep the session.
  if (
    options?.provider !== undefined &&
    (options.provider ?? "anthropic") !== (existing.sendOptions?.provider ?? "anthropic")
  ) {
    return "provider changed"
  }
  // ai-sdk (multi-turn) exposes a live `active` getter on its `q`: when true a
  // turn is genuinely in flight (e.g. a timeout's interrupt could not stop a
  // wedged stream before the renderer reused the session).
  if (typeof existing.q?.active === "boolean" && existing.q.active) {
    return "turn still active"
  }
  // Single-turn (Anthropic) sessions are retired from the map on EVERY
  // `session_ended` (resume rebuilds context next turn). So finding one still
  // registered here means its previous turn never ended — a stuck turn left
  // behind by a timeout. The Anthropic SDK exposes no `active` flag, so its
  // mere lingering presence is the signal. Restart rather than push into it.
  if (existing.multiTurn !== true) {
    return "stale single-turn session"
  }
  return null
}

export function providerVisibleSendPayloadIsSafe({ prompt, options }) {
  const sdk = options?.claudeAgentSdk
  return hasNoLeakingPiiDeep({
    prompt,
    systemPrompt: options?.systemPrompt,
    appendSystemPrompt: options?.appendSystemPrompt,
    ...(options?.agents ? { agents: options.agents } : {}),
    ...(sdk
      ? {
          claudeAgentSdk: {
            outputFormat: sdk.outputFormat,
            permissionPromptToolName: sdk.permissionPromptToolName,
            planModeInstructions: sdk.planModeInstructions,
            plugins: sdk.plugins,
            skills: sdk.skills,
            toolAliases: sdk.toolAliases,
            toolConfig: sdk.toolConfig,
            tools: sdk.tools,
          },
        }
      : {}),
  })
}

function handleSend(msg) {
  const { sessionId, prompt, options } = msg
  if (!sessionId) {
    log("error", "send: sessionId required")
    return
  }
  if (typeof prompt !== "string" && !Array.isArray(prompt)) {
    log("error", "send: prompt must be string or content-block array")
    return
  }
  // This is the final shared boundary before provider execution. Renderer
  // callers already apply the same gate, but headless/ACP callers do not pass
  // through the renderer and must fail closed here as well.
  if (!providerVisibleSendPayloadIsSafe({ prompt, options })) {
    log("error", "send: provider-visible payload rejected by the PII gate")
    emit({
      type: "session_ended",
      sessionId,
      error: "provider-visible payload rejected by the PII gate",
    })
    return
  }
  const existing = sessions.get(sessionId)
  if (existing) {
    // Defense-in-depth: close-and-restart any session that can't safely take a
    // new prompt in place (changed cwd, or a previous turn that never ended).
    const reason = restartReason(existing, options)
    if (reason) {
      log("warn", `send: restarting session ${sessionId} (${reason})`)
      handleClose({ sessionId })
      startSession(sessionId, prompt, options)
      return
    }
    // Advance the LIVE loop's turn id so its events are stamped for this turn.
    // Only reached for a session we're pushing into in place; a restarted one
    // got a fresh ref above, and the loop it replaced keeps its own.
    if (existing.turnRef) existing.turnRef.id = options?.turnId
    existing.pushUserMessage(prompt)
  } else {
    startSession(sessionId, prompt, options)
  }
}

async function handleInterrupt(msg) {
  const { sessionId } = msg
  const s = sessions.get(sessionId)
  if (!s) {
    log("warn", `interrupt: no session ${sessionId}`)
    return
  }
  try {
    await s.q.interrupt()
  } catch (err) {
    log("error", `interrupt failed: ${err?.message ?? err}`)
  }
  // Anthropic path: settle tool/approval round-trips the SDK interrupt doesn't
  // drain (`pendingPluginToolCalls` has no signal wiring). The ai-sdk path
  // already drains inside `q.interrupt()`, so this is a no-op there.
  try {
    s.drainPending?.("interrupted")
  } catch (err) {
    log("error", `drainPending (interrupt) failed: ${err?.message ?? err}`)
  }
}

// Manual context compaction. The generic (AI-SDK) session exposes
// `requestCompact`; the Anthropic session does too (it pushes a `/compact`
// turn the Agent SDK intercepts). Unknown / already-closed sessions are a
// no-op — manual compaction must never fault the host.
async function handleCompact(msg) {
  const { sessionId, focus } = msg
  const s = sessions.get(sessionId)
  if (!s) {
    log("warn", `compact: no session ${sessionId}`)
    return
  }
  if (typeof s.requestCompact !== "function") return
  try {
    await s.requestCompact(focus)
  } catch (err) {
    log("error", `compact failed: ${err?.message ?? err}`)
  }
}

// Undo a compaction: restore the pre-compaction message snapshot into the live
// AI-SDK session. Only the generic path exposes `restoreConversation`; the
// Anthropic session self-manages context and has no such hook (no-op there).
// Unknown / already-closed sessions are a no-op — restore must never fault.
// Pure routing extracted for testability; `handleRestore` binds the module map.
export function routeRestore(sessionsMap, msg, logFn = () => {}) {
  const { sessionId, messages } = msg
  const s = sessionsMap.get(sessionId)
  if (!s) {
    logFn("warn", `restore: no session ${sessionId}`)
    return false
  }
  if (typeof s.restoreConversation !== "function") return false
  try {
    return s.restoreConversation(messages) !== false
  } catch (err) {
    logFn("error", `restore failed: ${err?.message ?? err}`)
    return false
  }
}

function handleRestore(msg) {
  routeRestore(sessions, msg, log)
}

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
async function handleSetMode(msg) {
  const { sessionId, mode } = msg
  const s = sessions.get(sessionId)
  if (!s) {
    log("warn", `set_mode: no session ${sessionId}`)
    return
  }
  if (!VALID_PERMISSION_MODES.has(mode)) {
    log("warn", `set_mode: invalid mode ${mode}`)
    return
  }
  // Mutate the shared sendOptions ref so the ai-sdk gate (which reads
  // sendOptions.permissionMode live) and any later resolve see the new mode.
  if (s.sendOptions) s.sendOptions.permissionMode = mode
  // Anthropic only: drive the live SDK query so its native enforcement updates.
  if (typeof s.q?.setPermissionMode === "function") {
    try {
      await s.q.setPermissionMode(mode)
    } catch (err) {
      log("error", `set_mode failed: ${err?.message ?? err}`)
    }
  }
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
export async function runControlWithTimeout(fn, thisArg, args, timeoutMs = CONTROL_TIMEOUT_MS) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "control timed out" }), timeoutMs)
  })
  const invoke = (async () => {
    try {
      return { ok: true, result: await fn.apply(thisArg, args) }
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) }
    }
  })()
  try {
    return await Promise.race([invoke, timeout])
  } finally {
    clearTimeout(timer)
  }
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
export function routeSteer(sessionsMap, msg) {
  const { sessionId, prompt, priority, sourceMessageId } = msg
  const session = sessionsMap.get(sessionId)
  if (!session) return { ok: false, error: "no_active_session" }
  if ((session.sendOptions?.provider ?? "anthropic") !== "anthropic") {
    return { ok: false, error: "unsupported_provider" }
  }
  if (typeof prompt !== "string" && !Array.isArray(prompt)) {
    return { ok: false, error: "invalid_prompt" }
  }
  if (priority !== undefined && !["now", "next", "later"].includes(priority)) {
    return { ok: false, error: "invalid_priority" }
  }
  if (sourceMessageId !== undefined && typeof sourceMessageId !== "string") {
    return { ok: false, error: "invalid_source_message_id" }
  }
  if (typeof session.pushUserMessage !== "function") {
    return { ok: false, error: "unsupported_provider" }
  }
  try {
    const accepted = session.pushUserMessage(prompt, priority)
    if (accepted === false) return { ok: false, error: "input_closed" }
    session.scheduleSteerInputClose?.()
    return {
      ok: true,
      result: { accepted: true, ...(sourceMessageId ? { sourceMessageId } : {}) },
    }
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) }
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
export function controlPreflight(adapterId, method, params) {
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
async function handleControl(msg) {
  const { sessionId, requestId, method, params } = msg
  const respond = (extra) => emit(buildControlResponse({ sessionId, requestId, method, ...extra }))

  const rejection = controlPreflight(sessions.get(sessionId)?.runtimeAdapterId, method, params)
  if (rejection) {
    // A capability miss ALSO gets the typed `capability_error` event, because
    // that is what the canonical event stream carries; the control_response is
    // only how this particular request settles.
    if (rejection.capability) emit(capabilityError(sessionId, rejection.capability, method))
    respond({ ok: false, error: rejection.error })
    return
  }
  if (method === "steer") {
    respond(routeSteer(sessions, { sessionId, ...params }))
    return
  }
  const s = sessions.get(sessionId)
  if (!s) {
    respond({ ok: false, error: "no_active_session" })
    return
  }
  const fn = s.q?.[method]
  if (typeof fn !== "function") {
    respond({ ok: false, error: "unsupported_provider" })
    return
  }
  const outcome = await runControlWithTimeout(fn, s.q, controlArgs(method, params))
  // Keep the shared sendOptions ref consistent so any later resolve agrees with
  // the live switch (mirrors handleSetMode's permissionMode mutation). Only on a
  // confirmed (non-timed-out) success.
  if (outcome.ok && method === "setModel" && s.sendOptions && params?.model) {
    s.sendOptions.model = params.model
  }
  respond(outcome)
}

/**
 * Map a renderer `permission_response` to the SDK `PermissionResult` shape.
 *
 * Pure so the allow/deny mapping is unit-testable. The crux: an `allow` MUST
 * carry an `updatedInput` *record*. The renderer omits `updatedInput` whenever
 * the user approves a call unmodified, so we fall back to the ORIGINAL tool
 * input. Resolving with `updatedInput: undefined` fails the Agent-SDK
 * subprocess's zod schema (which requires a record), surfacing to the user as
 * `Tool permission request failed: ZodError`. When neither an edited input nor
 * a captured original is present, fall back to an empty record `{}` (which the
 * zod schema accepts) so the guarantee lives in THIS function, not solely in
 * the caller.
 *
 * `allow_always` used to be treated as a plain allow, with the "stop asking"
 * half enforced only parent-side. That left the user's intent stranded: the SDK
 * has `updatedPermissions` for exactly this, and without it the CLI's own rule
 * store never learned the decision — so "always allow" held for the renderer's
 * session and nowhere else. It now returns the suggestions the SDK offered
 * alongside the request.
 *
 * Suggestions targeting `localSettings` are dropped. Those write to the user's
 * on-disk settings file, and a click in a chat approval dialog is consent for
 * this session, not consent to edit their configuration.
 *
 * `rich` gates all of it. The legacy `claude_send` queue is still production
 * (ADR-0090 constraint 6: flag-off paths keep byte-identical behaviour), and
 * this is the same function on both rails — so the extra fields appear only for
 * a session carrying a frozen execution spec.
 *
 * @param {"allow"|"allow_always"|"deny"} decision
 * @param {{
 *   updatedInput?: Record<string, unknown>,
 *   message?: string,
 *   input?: Record<string, unknown>,
 *   suggestions?: Array<Record<string, unknown>>,
 *   interrupt?: boolean,
 * }} opts
 */
export function buildPermissionResult(
  decision,
  { updatedInput, message, input, suggestions, interrupt, rich = false } = {}
) {
  if (decision === "deny") {
    return {
      behavior: "deny",
      message: message ?? "denied by user",
      ...(rich && interrupt ? { interrupt: true } : {}),
      ...(rich ? { decisionClassification: "user_reject" } : {}),
    }
  }

  const always = decision === "allow_always"
  const durable = rich && always ? persistableSuggestions(suggestions) : []

  return {
    behavior: "allow",
    updatedInput: updatedInput ?? input ?? {},
    ...(durable.length > 0 ? { updatedPermissions: durable } : {}),
    ...(rich ? { decisionClassification: always ? "user_permanent" : "user_temporary" } : {}),
  }
}

/**
 * The suggestions an "always allow" may act on.
 *
 * `localSettings` is excluded on purpose — see {@link buildPermissionResult}.
 * Anything with an unrecognised shape is dropped rather than forwarded: these
 * become permission RULES, so a malformed entry is the one case where guessing
 * is worse than doing nothing.
 */
export function persistableSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) return []
  return suggestions.filter(
    (s) =>
      s &&
      typeof s === "object" &&
      typeof s.type === "string" &&
      typeof s.destination === "string" &&
      s.destination !== "localSettings"
  )
}

function handlePermissionResponse(msg) {
  const { sessionId, requestId, decision, updatedInput, message, interrupt } = msg
  const s = sessions.get(sessionId)
  if (!s) return
  const pending = s.pendingApprovals.get(requestId)
  if (!pending) return
  s.pendingApprovals.delete(requestId)

  pending.resolve(
    buildPermissionResult(decision, {
      updatedInput,
      message,
      input: pending.input,
      // The SDK's own suggestions, captured when the request was raised — not
      // anything the renderer supplied. A renderer-authored rule set would be
      // an unreviewed write into the permission store.
      suggestions: pending.suggestions,
      interrupt,
      rich: Boolean(s.sendOptions?.execution),
    })
  )
}

/**
 * Resolve a pending plugin tool call (M2). Parallels
 * `handlePermissionResponse` — the renderer's `handlePluginToolExec`
 * resolved this `toolUseId`, sent the response back via Tauri, and now
 * we hand the result to the in-process MCP wrapper waiting on it.
 *
 * Unknown `toolUseId`s are silently ignored — they only happen when the
 * sidecar already restarted (the pending map is per-session) or the
 * response races a session close, neither of which should fault the host.
 */
function handlePluginToolResponse(msg) {
  const { sessionId, toolUseId, result, error } = msg
  const s = sessions.get(sessionId)
  if (!s || !s.pendingPluginToolCalls) return
  const pending = s.pendingPluginToolCalls.get(toolUseId)
  if (!pending) return
  s.pendingPluginToolCalls.delete(toolUseId)
  pending.resolve({ result, error })
}

/**
 * Code-level protocol adapter round-trip (P2-E). The renderer executes the
 * plugin's adapter and streams AI-SDK-shaped chunks back; we push them into
 * the per-session `pendingProtocolExecs` channel the sidecar's code-adapter
 * is consuming. Unknown execIds are ignored (session restarted / raced a
 * close), and only the ai-sdk session exposes the map.
 */
/**
 * Resolve a pending tool-result review (plugin SDK PostToolUse rewrite).
 * Parallels `handlePermissionResponse` — the renderer reviewed the tool output
 * and sends back an optional `updatedToolOutput`. Unknown `reviewId`s are
 * ignored (session restarted / raced a close); only the ai-sdk session exposes
 * the map.
 */
function handleToolResultDecision(msg) {
  const { sessionId, reviewId, updatedToolOutput } = msg
  const s = sessions.get(sessionId)
  if (!s || !s.pendingToolResultReviews) return
  const pending = s.pendingToolResultReviews.get(reviewId)
  if (!pending) return
  s.pendingToolResultReviews.delete(reviewId)
  pending.resolve(updatedToolOutput)
}

function handleProtocolAdapterChunk(msg) {
  const { sessionId, execId, chunk } = msg
  const s = sessions.get(sessionId)
  const channel = s?.pendingProtocolExecs?.get(execId)
  if (channel) channel.push(chunk)
}

function handleProtocolAdapterDone(msg) {
  const { sessionId, execId, usage } = msg
  const s = sessions.get(sessionId)
  const channel = s?.pendingProtocolExecs?.get(execId)
  if (!channel) return
  channel.finish(usage)
  s.pendingProtocolExecs.delete(execId)
}

function handleProtocolAdapterError(msg) {
  const { sessionId, execId, error } = msg
  const s = sessions.get(sessionId)
  const channel = s?.pendingProtocolExecs?.get(execId)
  if (!channel) return
  channel.fail(error ?? "protocol adapter error")
  s.pendingProtocolExecs.delete(execId)
}

export function routeClose(sessionsMap, msg, logFn = () => {}) {
  const { sessionId } = msg
  const s = sessionsMap.get(sessionId)
  if (!s) return false
  try {
    s.closeInput()
    if (typeof s.q?.close === "function") s.q.close()
  } catch (err) {
    logFn("error", `close failed: ${err?.message ?? err}`)
  }
  // Settle any pending tool/approval round-trips so a renderer that never
  // answers can't keep promises (and the agent loop) alive past teardown. The
  // ai-sdk session has no `drainPending` (its `closeInput` aborts the in-flight
  // request); the Anthropic session drains here.
  try {
    s.drainPending?.("session closed")
  } catch (err) {
    logFn("error", `drainPending (close) failed: ${err?.message ?? err}`)
  }
  sessionsMap.delete(sessionId)
  return true
}

function handleClose(msg) {
  routeClose(sessions, msg, log)
}

// ---- Main read loop -------------------------------------------------------

export async function smoke() {
  // Quick round-trip test invoked with `node claude-host.mjs --smoke`.
  // Requires the SDK to be authenticated (env ANTHROPIC_API_KEY etc.).
  console.error("[sidecar smoke] starting…")
  const s = startSession("smoke-1", "Reply with the single word PONG.")
  // Wait until the session ends.
  while (sessions.has("smoke-1")) {
    await new Promise((r) => setTimeout(r, 200))
  }
  console.error("[sidecar smoke] done")
  void s
  process.exit(0)
}

/**
 * ADR-0090 Phase 3 — command idempotency. A `commandId` the session already
 * processed is acknowledged (`command_ack { duplicate: true }`) and dropped,
 * so at-least-once senders (AgentExecutionHandle) can retry safely.
 * Session-scoped LRU of 128 ids. Returns true when the message was dropped.
 * Exported for the co-located test.
 */
export function dropDuplicateCommand(sessionsMap, msg, emitFn) {
  if (!msg?.commandId || !msg?.sessionId) return false
  const session = sessionsMap.get(msg.sessionId)
  if (!session) return false
  if (!session.processedCommandIds) session.processedCommandIds = new Map()
  if (session.processedCommandIds.has(msg.commandId)) {
    emitFn({
      type: "command_ack",
      sessionId: msg.sessionId,
      commandId: msg.commandId,
      duplicate: true,
    })
    return true
  }
  session.processedCommandIds.set(msg.commandId, true)
  if (session.processedCommandIds.size > 128) {
    const oldest = session.processedCommandIds.keys().next().value
    session.processedCommandIds.delete(oldest)
  }
  return false
}

/**
 * ADR-0090 Phase 3 — capability gating. A command the session's frozen
 * runtime adapter cannot serve returns a TYPED `capability_error`, never a
 * silent no-op. Legacy (spec-less) sessions are never blocked. Returns true
 * when the message was blocked. Exported for the co-located test.
 */
export function blockUnsupportedCommand(sessionsMap, msg, emitFn) {
  if (!msg?.sessionId) return false
  const session = sessionsMap.get(msg.sessionId)
  const adapterId = session?.runtimeAdapterId
  if (adapterId && !commandSupported(adapterId, msg.type)) {
    emitFn(capabilityError(msg.sessionId, msg.type, msg.type))
    return true
  }
  return false
}

function startReadLoop() {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on("line", (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch (err) {
      log("error", `bad JSON line: ${err?.message ?? err}`)
      return
    }
    if (dropDuplicateCommand(sessions, msg, emit)) return
    if (blockUnsupportedCommand(sessions, msg, emit)) return
    switch (msg.type) {
      case "send":
        handleSend(msg)
        break
      case "interrupt":
        void handleInterrupt(msg)
        break
      case "compact":
        void handleCompact(msg)
        break
      case "restore":
        handleRestore(msg)
        break
      case "set_mode":
        void handleSetMode(msg)
        break
      case "control":
        void handleControl(msg)
        break
      case "session_api":
        // Session-level reads and mutations that need no live session (list,
        // rename, fork, import, …). Separate from `control` because those
        // resolve a running query by id and these deliberately do not.
        void handleSessionApi(msg, {
          emit,
          store: sessionStoreFromSendOptions(msg?.sendOptions ?? {}, { hostRpc, log }),
        })
        break
      case "feature_call":
        void featureCalls.call(msg)
        break
      case "feature_call_abort":
        featureCalls.abort(msg.requestId)
        break
      case "permission_response":
        handlePermissionResponse(msg)
        break
      case "plugin_tool_response":
        handlePluginToolResponse(msg)
        break
      case "host_rpc_result":
        // Answered by Rust directly (never by the renderer) — see host-rpc.mjs.
        hostRpc.resolveResult(msg)
        break
      case "tool_result_decision":
        handleToolResultDecision(msg)
        break
      case "protocol_adapter_chunk":
        if (!featureCalls.handleProtocolAdapterMessage(msg)) handleProtocolAdapterChunk(msg)
        break
      case "protocol_adapter_done":
        if (!featureCalls.handleProtocolAdapterMessage(msg)) handleProtocolAdapterDone(msg)
        break
      case "protocol_adapter_error":
        if (!featureCalls.handleProtocolAdapterMessage(msg)) handleProtocolAdapterError(msg)
        break
      case "close":
        handleClose(msg)
        break
      default:
        log("warn", `unknown command type: ${msg.type}`)
    }
  })
  rl.on("close", () => {
    // Parent closed our stdin — shut down all sessions gracefully.
    // Fail in-flight host RPCs first: their replies can never arrive now, and
    // a tool awaiting one would otherwise hang until its own timeout.
    hostRpc.rejectAll("sidecar stdin closed")
    for (const id of Array.from(sessions.keys())) {
      handleClose({ sessionId: id })
    }
    process.exit(0)
  })

  const { sdkVersion, sidecarVersion } = readVersionInfo()
  emit({ type: "ready", sdkVersion, sidecarVersion })
  logv(`ready sdk=${sdkVersion ?? "?"} sidecar=${sidecarVersion ?? "?"}`)
}

// Run the protocol loop only when executed as a process entry point — importing
// this module (e.g. from the co-located test) must NOT start reading stdin or
// emit `ready`.
//
// `COGNIA_ROLE === "sidecar"` is the second entry signal: inside the packaged
// CLI binary there is no system `node`, so the binary self-execs itself with
// that env and the sidecar role IMPORTS this module to launch it (see
// cli/src/runtime/sidecar-role.ts). In that path `process.argv[1]` is the pkg
// bootstrap, not this file, so the argv check alone would never fire and the
// host would exit before emitting `ready`. The co-located test imports the
// module WITHOUT that env, so it stays guarded.
let hostStarted = false

/**
 * Start the agent host protocol loop (ADR-0090 Phase 3). Idempotent: the
 * `claude-host.mjs` compatibility shim and the packaged-CLI sidecar role can
 * both request a start without double-reading stdin.
 */
export function startAgentHost() {
  if (hostStarted) return
  hostStarted = true
  startReadLoop()
}

const isEntryPoint = (() => {
  try {
    if (process.env.COGNIA_ROLE === "sidecar") return true
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  } catch {
    return false
  }
})()

if (isEntryPoint) {
  if (process.argv.includes("--smoke")) {
    smoke().catch((e) => {
      console.error(e)
      process.exit(1)
    })
  } else {
    startAgentHost()
  }
}
