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
import { dispatch } from "./dispatch/index.mjs"

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

function startSession(sessionId, firstPrompt, sendOptions = {}) {
  // Wrap the emitter so a `session_ended` from the dispatcher cleans up the
  // sessions map without each dispatcher having to know about it. Keeps the
  // map a private concern of this file.
  const wrappedEmit = (msg) => {
    emit(msg)
    if (msg && msg.type === "session_ended" && msg.sessionId === sessionId) {
      sessions.delete(sessionId)
    }
  }
  const session = dispatch({
    sessionId,
    firstPrompt,
    sendOptions,
    emit: wrappedEmit,
    log,
  })
  if (!session) return null
  sessions.set(sessionId, session)
  return session
}

// ---- Inbound command handling --------------------------------------------

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
    // If the working directory changed, restart the session so the SDK
    // picks up the new cwd. Other option changes (model, system prompt)
    // are handled by the frontend closing the session explicitly.
    if (options?.cwd !== undefined && options.cwd !== existing.sendOptions?.cwd) {
      handleClose({ sessionId })
      startSession(sessionId, prompt, options)
    } else {
      existing.pushUserMessage(prompt)
    }
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

if (process.argv.includes("--smoke")) {
  smoke().catch((e) => {
    console.error(e)
    process.exit(1)
  })
} else {
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
