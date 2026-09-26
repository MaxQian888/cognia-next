// Shared harness for the *.live.test.* sidecar suites and the ADR-0090
// conformance suite (tests/conformance/harness/sidecar-process.mjs).
//
// These tests boot the REAL sidecar (`claude-host.mjs`) — which runs the real
// `@anthropic-ai/claude-agent-sdk` `query()` and the claude-code CLI subprocess
// it spawns — against a minimal in-process mock of the Anthropic Messages API.
// Pointing `ANTHROPIC_BASE_URL` at the mock (with a dummy `ANTHROPIC_API_KEY`)
// is the same enabler the Tauri chat E2E specs use, so these node-only tests
// cover the compose→sidecar→stream boundary without a browser or Tauri shell.
//
// Lives in test-support/, which is never shipped and never imported by
// production code (audit:sidecar-architecture).

import http from "node:http"
import type { ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SIDECAR = path.resolve(HERE, "..", "claude-host.mjs")

/** One JSON line the sidecar wrote to stdout (the host protocol's frames). */
export interface SidecarFrame {
  type?: string
  event?: { type?: string; message?: { content?: unknown } }
  [key: string]: unknown
}

/** A parsed `/v1/messages` request body the mock received. */
export type MessagesRequest = Record<string, unknown> & { model?: string }

export interface MockAnthropicOptions {
  chunks?: string[]
  /** Vary the reply per call; key it on `body`, not `callIndex` (see below). */
  replyFor?: (body: MessagesRequest, callIndex: number) => string[]
  delayMs?: number
}

export interface MockAnthropic {
  readonly messagesCalls: MessagesRequest[]
  listen(): Promise<string>
  readonly baseUrl: string
  close(): Promise<void>
}

/** Write one Anthropic Messages SSE response carrying `chunks` as text deltas. */
function writeMessagesSse(res: ServerResponse, chunks: string[], model: string | undefined): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const id = `msg_mock_${Math.random().toString(36).slice(2, 8)}`
  const send = (event: string, data: unknown): void => {
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
 *
 * CAUTION: key `replyFor` on the request `body` content, not `callIndex` — the
 * claude-code CLI can issue auxiliary /v1/messages calls (title generation,
 * probes) whose count varies by CLI version, so call indices are not stable.
 */
export function startMockAnthropic({
  chunks = ["PONG"],
  replyFor,
  delayMs = 0,
}: MockAnthropicOptions = {}): MockAnthropic {
  const messagesCalls: MessagesRequest[] = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c: Buffer) => (body += c))
    req.on("end", async () => {
      if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
        let parsed: MessagesRequest = {}
        try {
          parsed = JSON.parse(body || "{}") as MessagesRequest
        } catch {
          parsed = {}
        }
        messagesCalls.push(parsed)
        const reply = replyFor ? replyFor(parsed, messagesCalls.length - 1) : chunks
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
        writeMessagesSse(res, reply, typeof parsed.model === "string" ? parsed.model : undefined)
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
      return new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo
          baseUrl = `http://127.0.0.1:${addr.port}`
          resolve(baseUrl)
        })
      })
    },
    get baseUrl() {
      return baseUrl
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export interface SpawnSidecarOptions {
  baseUrl: string
  apiKey?: string
  extraEnv?: NodeJS.ProcessEnv
}

export interface WaitForOptions {
  timeoutMs?: number
  label?: string
  /** Only consider events at or after this index (from `mark()`). */
  sinceIndex?: number
}

export interface SidecarController {
  readonly child: ChildProcessWithoutNullStreams
  readonly events: SidecarFrame[]
  send(command: unknown): void
  mark(): number
  waitFor(pred: (frame: SidecarFrame) => boolean, opts?: WaitForOptions): Promise<SidecarFrame>
  close(): Promise<void>
  readonly stderr: string
}

/**
 * Spawn the real sidecar pointed at a mock Anthropic base URL. Returns a small
 * controller: `send` a JSON-line command, `waitFor(predicate)` an emitted
 * stdout message, and `close()` to tear down.
 */
export function spawnSidecar({
  baseUrl,
  apiKey = "test-e2e-key",
  extraEnv = {},
}: SpawnSidecarOptions): SidecarController {
  const events: SidecarFrame[] = []
  const waiters: Array<{
    pred: (frame: SidecarFrame) => boolean
    resolve: (frame: SidecarFrame) => void
  }> = []
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
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg: SidecarFrame
      try {
        msg = JSON.parse(line) as SidecarFrame
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
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString()
  })

  function send(obj: unknown): void {
    child.stdin.write(JSON.stringify(obj) + "\n")
  }

  /** Current event count — capture before `send` to wait only for NEW events
   *  (pass as `sinceIndex` to `waitFor`) so a second turn doesn't re-match the
   *  first turn's stale `assistant`/`result`. */
  function mark(): number {
    return events.length
  }

  function waitFor(
    pred: (frame: SidecarFrame) => boolean,
    { timeoutMs = 25_000, label = "event", sinceIndex = 0 }: WaitForOptions = {}
  ): Promise<SidecarFrame> {
    const existing = events.slice(sinceIndex).find(pred)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const entry = {
        pred,
        resolve: (m: SidecarFrame) => {
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

  async function close(): Promise<void> {
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
export function assistantText(assistantEvent: SidecarFrame | undefined): string {
  const blocks = assistantEvent?.event?.message?.content
  if (!Array.isArray(blocks)) return ""
  return blocks
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string"
    )
    .map((b) => b.text)
    .join("")
}
