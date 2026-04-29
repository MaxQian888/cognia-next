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

import { query } from "@anthropic-ai/claude-agent-sdk"
import { randomUUID } from "node:crypto"
import readline from "node:readline"

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

// ---- Streaming input async-iterable ---------------------------------------

function makeInputStream() {
  /** @type {Array<any>} */
  const queue = []
  /** @type {Array<{resolve: (v: any) => void}>} */
  const waiters = []
  let closed = false

  const push = (item) => {
    if (closed) return
    if (waiters.length > 0) {
      waiters.shift().resolve({ value: item, done: false })
    } else {
      queue.push(item)
    }
  }

  const close = () => {
    closed = true
    while (waiters.length > 0) {
      waiters.shift().resolve({ value: undefined, done: true })
    }
  }

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true })
          }
          return new Promise((resolve) => waiters.push({ resolve }))
        },
        return() {
          close()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }

  return { iterable, push, close }
}

// ---- Session lifecycle ----------------------------------------------------

function startSession(sessionId, firstPrompt, sendOptions = {}) {
  const inputStream = makeInputStream()
  /** @type {Map<string, {resolve: (r: any) => void}>} */
  const pendingApprovals = new Map()

  // Build options — caller passes user-supplied bits (model, system prompt, cwd, etc.).
  // Resume / fork: the SDK takes a single `resume` field (session id) and a
  // `forkSession` boolean. We accept them as two separate inputs for clarity;
  // Rust validates they're mutually exclusive.
  const resumeId = sendOptions.resumeSessionId ?? sendOptions.forkFromSessionId
  const isFork = sendOptions.forkFromSessionId != null

  const options = {
    cwd: sendOptions.cwd,
    model: sendOptions.model,
    fallbackModel: sendOptions.fallbackModel,
    systemPrompt: sendOptions.systemPrompt,
    appendSystemPrompt: sendOptions.appendSystemPrompt,
    allowedTools: sendOptions.allowedTools,
    disallowedTools: sendOptions.disallowedTools,
    additionalDirectories: sendOptions.additionalDirectories,
    permissionMode: sendOptions.permissionMode,
    mcpServers: sendOptions.mcpServers,
    maxTurns: sendOptions.maxTurns,
    includePartialMessages: sendOptions.includePartialMessages,
    settingSources: sendOptions.settingSources,
    agents: sendOptions.agents,
    strictMcpConfig: sendOptions.strictMcpConfig,
    effort: sendOptions.effort,
    resume: resumeId,
    forkSession: isFork ? true : undefined,
    env: { ...process.env, ...(sendOptions.env ?? {}) },

    // Permission gateway: every tool call is forwarded to the parent for a decision.
    canUseTool: (toolName, input, ctx) => {
      const requestId = randomUUID()
      emit({
        type: "permission_request",
        sessionId,
        requestId,
        toolUseID: ctx.toolUseID,
        toolName,
        input,
        title: ctx.title,
        displayName: ctx.displayName,
        description: ctx.description,
        blockedPath: ctx.blockedPath,
        decisionReason: ctx.decisionReason,
        suggestions: ctx.suggestions,
      })
      return new Promise((resolve) => {
        pendingApprovals.set(requestId, { resolve })
        // Abort if the parent aborts mid-decision.
        if (ctx.signal) {
          const onAbort = () => {
            if (pendingApprovals.delete(requestId)) {
              resolve({ behavior: "deny", message: "aborted" })
            }
          }
          if (ctx.signal.aborted) onAbort()
          else ctx.signal.addEventListener("abort", onAbort, { once: true })
        }
      })
    },
  }

  // Strip undefined- and null-valued keys so the SDK uses its defaults.
  // Rust's serde encodes `Option::None` as JSON `null`, which the SDK's
  // option parser treats as a real value and crashes on (e.g. it tries to
  // read `null.type` for `systemPrompt`). Defensive normalisation here.
  for (const k of Object.keys(options)) {
    if (options[k] === undefined || options[k] === null) delete options[k]
  }

  const q = query({ prompt: inputStream.iterable, options })

  /** @type {Session} */
  const session = {
    q,
    // `content` may be a plain string or an array of content blocks
    // (text + image). The SDK accepts either shape verbatim.
    pushUserMessage: (content) =>
      inputStream.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: sessionId,
      }),
    closeInput: inputStream.close,
    pendingApprovals,
  }
  sessions.set(sessionId, session)

  // Push the first turn.
  session.pushUserMessage(firstPrompt)

  // Pipe SDK events to the parent.
  let sdkSessionIdSeen = false
  ;(async () => {
    try {
      for await (const evt of q) {
        // Capture the SDK-issued session id on the first event that carries
        // one. The parent persists it so we can pass `resume: <id>` after a
        // sidecar restart and continue the conversation seamlessly.
        if (!sdkSessionIdSeen && evt && typeof evt.session_id === "string") {
          sdkSessionIdSeen = true
          emit({
            type: "sdk_session_id",
            sessionId,
            sdkSessionId: evt.session_id,
          })
        }
        emit({ type: "event", sessionId, event: evt })
        if (evt.type === "result") {
          // The SDK emits a final 'result' message per turn. We keep the session
          // alive (it still accepts further user turns via streaming input) until
          // the parent explicitly closes it or the generator finishes.
        }
      }
      emit({ type: "session_ended", sessionId })
    } catch (err) {
      emit({
        type: "session_ended",
        sessionId,
        error: err?.message ?? String(err),
      })
    } finally {
      sessions.delete(sessionId)
    }
  })()

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
