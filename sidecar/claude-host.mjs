// Cognia Claude sidecar: bridges Tauri (parent) <-> @anthropic-ai/claude-agent-sdk
// Protocol: JSON-lines over stdio.
//
// Inbound (parent -> sidecar) on stdin:
//   { type: "send",                sessionId, prompt, options? }
//     prompt: string | Array<{ type: "text", text } | { type: "image", source }>
//   { type: "interrupt",           sessionId }
//   { type: "permission_response", sessionId, requestId, decision: "allow"|"allow_always"|"deny" }
//   { type: "close",               sessionId }
//
// Outbound (sidecar -> parent) on stdout, one JSON object per line:
//   { type: "event",              sessionId, event: SDKMessage }
//   { type: "permission_request", sessionId, requestId, toolName, input, title?, displayName?, description? }
//   { type: "session_ended",      sessionId, result?: SDKResultMessage, error?: string }
//   { type: "ready" }
//   { type: "log",                level, message }

// Side-effect import — must come first so the global fetch is patched
// before the Claude agent SDK loads. The interceptor emits a `usage_headers`
// event for every response on `api.anthropic.com`, which the renderer's
// usage-collector subscribes to (Phase 4a of the Claude subscription ADR).
import "./fetch-interceptor.mjs"

import readline from "node:readline"
import { dispatch } from "./dispatch/index.mjs"

// ---- IO helpers -----------------------------------------------------------

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

  emit({ type: "ready" })
}
