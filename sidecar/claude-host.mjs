// Cognia Claude sidecar: bridges Tauri (parent) <-> @anthropic-ai/claude-agent-sdk
// Protocol: JSON-lines over stdio.
//
// Inbound (parent -> sidecar) on stdin:
//   { type: "send",                sessionId, prompt, options? }
//     prompt: string | Array<{ type: "text", text } | { type: "image", source }>
//   { type: "interrupt",           sessionId }
//   { type: "permission_response", sessionId, requestId, decision: "allow"|"allow_always"|"deny" }
//   { type: "plugin_tool_response", sessionId, toolUseId, result?, error? }
//   { type: "tool_result_decision", sessionId, reviewId, updatedToolOutput? }
//   { type: "close",               sessionId }
//
// Outbound (sidecar -> parent) on stdout, one JSON object per line:
//   { type: "event",              sessionId, event: SDKMessage }
//   { type: "permission_request", sessionId, requestId, toolName, input, title?, displayName?, description? }
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

import readline from "node:readline"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { dispatch } from "./dispatch/index.mjs"
import { isControlMethod, controlArgs, buildControlResponse } from "./dispatch/control.mjs"

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
 * @param {(msg: any) => void} emitFn  forward an event to the parent (stdout)
 * @param {Map<string, any>} sessionsMap
 * @param {string} sessionId
 */
export function makeWrappedEmit(emitFn, sessionsMap, sessionId, getOwner) {
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
    emitFn(msg)
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

function startSession(sessionId, firstPrompt, sendOptions = {}) {
  // Wired after `dispatch` returns so the wrapped emitter can verify it still
  // owns the map entry before retiring it (defends against a superseded old
  // loop evicting this replacement — see `makeWrappedEmit`).
  const ownerRef = { session: null }
  const wrappedEmit = makeWrappedEmit(emit, sessions, sessionId, () => ownerRef.session)
  const session = dispatch({
    sessionId,
    firstPrompt,
    sendOptions,
    emit: wrappedEmit,
    log,
  })
  if (!session) return null
  ownerRef.session = session
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

// Drive a live session's SDK `Query` control method (getContextUsage,
// mcpServerStatus, reconnectMcpServer, toggleMcpServer, supportedModels,
// supportedCommands, setModel) and reply with a `control_response` correlated by
// `requestId`. These methods are streaming-input-only and Anthropic-path only
// (the ai-sdk `q` lacks them → `unsupported_provider`). Never throws — a control
// request must never fault the host (mirrors handleSetMode / handleInterrupt).
async function handleControl(msg) {
  const { sessionId, requestId, method, params } = msg
  const respond = (extra) => emit(buildControlResponse({ sessionId, requestId, method, ...extra }))
  if (!isControlMethod(method)) {
    respond({ ok: false, error: "unknown_method" })
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
  try {
    const result = await fn.apply(s.q, controlArgs(method, params))
    // Keep the shared sendOptions ref consistent so any later resolve agrees
    // with the live switch (mirrors handleSetMode's permissionMode mutation).
    if (method === "setModel" && s.sendOptions && params?.model) {
      s.sendOptions.model = params.model
    }
    respond({ ok: true, result })
  } catch (err) {
    respond({ ok: false, error: err?.message ?? String(err) })
  }
}

function handlePermissionResponse(msg) {
  const { sessionId, requestId, decision, updatedInput, message } = msg
  const s = sessions.get(sessionId)
  if (!s) return
  const pending = s.pendingApprovals.get(requestId)
  if (!pending) return
  s.pendingApprovals.delete(requestId)

  if (decision === "deny") {
    pending.resolve({ behavior: "deny", message: message ?? "denied by user" })
  } else if (decision === "allow_always") {
    // The "always" behavior is enforced by the parent (it stops asking for the
    // matching scope). For the SDK we just allow this individual call.
    pending.resolve({ behavior: "allow", updatedInput: updatedInput ?? undefined })
  } else {
    pending.resolve({ behavior: "allow", updatedInput: updatedInput ?? undefined })
  }
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

function handleClose(msg) {
  const { sessionId } = msg
  const s = sessions.get(sessionId)
  if (!s) return
  try {
    s.closeInput()
    s.q.close()
  } catch (err) {
    log("error", `close failed: ${err?.message ?? err}`)
  }
  sessions.delete(sessionId)
}

// ---- Main read loop -------------------------------------------------------

async function smoke() {
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
      case "set_mode":
        void handleSetMode(msg)
        break
      case "control":
        void handleControl(msg)
        break
      case "permission_response":
        handlePermissionResponse(msg)
        break
      case "plugin_tool_response":
        handlePluginToolResponse(msg)
        break
      case "tool_result_decision":
        handleToolResultDecision(msg)
        break
      case "protocol_adapter_chunk":
        handleProtocolAdapterChunk(msg)
        break
      case "protocol_adapter_done":
        handleProtocolAdapterDone(msg)
        break
      case "protocol_adapter_error":
        handleProtocolAdapterError(msg)
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
const isEntryPoint = (() => {
  try {
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
    startReadLoop()
  }
}
