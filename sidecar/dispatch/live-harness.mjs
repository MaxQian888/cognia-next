// Shared harness for the *.live.test.mjs sidecar tests.
//
// These tests boot the REAL sidecar (`claude-host.mjs`) — which runs the real
// `@anthropic-ai/claude-agent-sdk` `query()` and the claude-code CLI subprocess
// it spawns — against a minimal in-process mock of the Anthropic Messages API.
// Pointing `ANTHROPIC_BASE_URL` at the mock (with a dummy `ANTHROPIC_API_KEY`)
// is the same enabler the Tauri chat E2E specs use, so these node-only tests
// cover the compose→sidecar→stream boundary without a browser or Tauri shell.
//
// This file is intentionally NOT named `*.test.mjs` so the `node --test` glob
// doesn't execute it as a test suite — it is a helper module.

import http from "node:http"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SIDECAR = path.resolve(HERE, "..", "claude-host.mjs")

/** Write one Anthropic Messages SSE response carrying `chunks` as text deltas. */
function writeMessagesSse(res, chunks, model) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const id = `msg_mock_${Math.random().toString(36).slice(2, 8)}`
  const send = (event, data) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  send("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: model ?? "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })
  for (const chunk of chunks) {
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    })
  }
  send("content_block_stop", { type: "content_block_stop", index: 0 })
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: chunks.join("").length },
  })
  send("message_stop", { type: "message_stop" })
  res.end()
}

/**
 * Minimal mock of the Anthropic Messages API.
 *
 * `replyFor(body, callIndex)` lets a test vary the reply per call (used by the
 * multi-turn test to echo prior context). Defaults to a single "PONG" reply.
 */
export function startMockAnthropic({ chunks = ["PONG"], replyFor } = {}) {
  const messagesCalls = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
        let parsed = {}
        try {
          parsed = JSON.parse(body || "{}")
        } catch {
          parsed = {}
        }
        messagesCalls.push(parsed)
        const reply = replyFor ? replyFor(parsed, messagesCalls.length - 1) : chunks
        writeMessagesSse(res, reply, parsed.model)
        return
      }
      // The claude-code CLI probes `HEAD /` (and may hit other paths); answer
      // 200 so it proceeds to POST /v1/messages.
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
  })

  let baseUrl = ""
  return {
    messagesCalls,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address()
          baseUrl = `http://127.0.0.1:${addr.port}`
          resolve(baseUrl)
        })
      })
    },
    get baseUrl() {
      return baseUrl
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * Spawn the real sidecar pointed at a mock Anthropic base URL. Returns a small
 * controller: `send` a JSON-line command, `waitFor(predicate)` an emitted
 * stdout message, and `close()` to tear down.
 */
export function spawnSidecar({ baseUrl, apiKey = "test-e2e-key", extraEnv = {} } = {}) {
  const events = []
  const waiters = []
  let stderr = ""

  const child = spawn("node", [SIDECAR], {
    cwd: path.dirname(SIDECAR),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: apiKey,
      // Drop any inherited OAuth bearer — the SDK prefers it over the API key
      // and would bypass the mock base URL.
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ...extraEnv,
    },
  })

  let buf = ""
  child.stdout.on("data", (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      events.push(msg)
      for (const w of waiters.slice()) {
        if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(msg)
        }
      }
    }
  })
  child.stderr.on("data", (d) => {
    stderr += d.toString()
  })

  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n")
  }

  /** Current event count — capture before `send` to wait only for NEW events
   *  (pass as `sinceIndex` to `waitFor`) so a second turn doesn't re-match the
   *  first turn's stale `assistant`/`result`. */
  function mark() {
    return events.length
  }

  function waitFor(pred, { timeoutMs = 25_000, label = "event", sinceIndex = 0 } = {}) {
    const existing = events.slice(sinceIndex).find(pred)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const entry = {
        pred,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      }
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(entry)
        if (idx !== -1) waiters.splice(idx, 1)
        const seen = events.map((e) => e.type + (e.event ? `:${e.event.type}` : "")).join(", ")
        reject(
          new Error(
            `waitFor(${label}) timed out after ${timeoutMs}ms.\n` +
              `events seen: [${seen}]\n` +
              `sidecar stderr (tail):\n${stderr.slice(-1500)}`
          )
        )
      }, timeoutMs)
      waiters.push(entry)
    })
  }

  async function close() {
    try {
      child.stdin.end()
    } catch {
      // best-effort
    }
    try {
      child.kill("SIGTERM")
    } catch {
      // best-effort
    }
  }

  return {
    child,
    events,
    send,
    mark,
    waitFor,
    close,
    get stderr() {
      return stderr
    },
  }
}

/** Extract concatenated assistant text from an `assistant` SDK event. */
export function assistantText(assistantEvent) {
  const blocks = assistantEvent?.event?.message?.content ?? []
  return blocks
    .filter((b) => b && b.type === "text")
    .map((b) => b.text)
    .join("")
}
