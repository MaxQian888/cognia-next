/**
 * Mock Anthropic Messages API for E2E workflow tests.
 *
 * Implements the slice of `POST /v1/messages` that the AI SDK `anthropic`
 * provider talks to from the `ai.prompt`, `ai.classify`, `ai.extract`, and
 * `ai.embed` executors. Specs point the executor's `params.baseURL` at this
 * server so the LLM call lands here instead of api.anthropic.com.
 *
 * Lifecycle mirrors `mock-v2-server.ts`: start, configure scenarios + canned
 * responses, run assertions, stop. Reset between tests to clear captured
 * requests.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createExpressApp = () => require("express")() as import("express").Application

import type { Server } from "http"

export interface MessagesRequestPayload {
  model: string
  max_tokens: number
  system?: string
  messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }>
  temperature?: number
  stop_sequences?: string[]
  metadata?: Record<string, unknown>
}

export interface MessagesResponse {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: Array<{ type: "text"; text: string }>
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence"
  usage: { input_tokens: number; output_tokens: number }
}

export interface EmbeddingResponse {
  object: "list"
  data: Array<{ object: "embedding"; embedding: number[]; index: number }>
  model: string
  usage: { prompt_tokens: number; total_tokens: number }
}

export type MessagesScenario =
  | { kind: "echo"; suffix?: string }
  | { kind: "canned"; text: string }
  | { kind: "json"; payload: unknown }
  | { kind: "rate-limited"; retryAfterSeconds?: number }
  | { kind: "overloaded" }
  | { kind: "auth-error" }
  | { kind: "server-error"; status: number; message: string }
  | { kind: "stream-text"; chunks: string[] }

export interface MockAnthropicServer {
  start(port?: number): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string

  setMessagesScenario(scenario: MessagesScenario): void
  /** Set the embedding vector returned by /v1/embeddings calls. */
  setEmbeddingVector(vector: number[]): void

  /** Wait until N message calls have been captured. */
  waitForMessages(count: number, timeoutMs?: number): Promise<MessagesRequestPayload[]>
  /** All /v1/messages payloads captured so far. */
  readonly messagesCalls: MessagesRequestPayload[]
  /** All /v1/embeddings payloads captured so far. */
  readonly embeddingsCalls: Array<{ model: string; input: string | string[] }>
  /** Reset captured calls + scenario back to echo. */
  reset(): void
}

export function createMockAnthropicServer(): MockAnthropicServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = createExpressApp() as any
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require("express") as typeof import("express")
  app.use(express.json({ limit: "8mb" }))

  let server: Server | null = null
  let _port = 0
  let scenario: MessagesScenario = { kind: "echo" }
  let embeddingVector: number[] = Array.from({ length: 16 }, (_, i) => (i + 1) / 16)
  const messagesCalls: MessagesRequestPayload[] = []
  const embeddingsCalls: Array<{ model: string; input: string | string[] }> = []
  const messagesResolvers: Array<{ count: number; resolve: () => void }> = []

  const renderText = (req: MessagesRequestPayload): string => {
    const last = req.messages[req.messages.length - 1]
    const userText =
      typeof last?.content === "string"
        ? last.content
        : Array.isArray(last?.content)
          ? last.content
              .map((c) =>
                typeof c === "object" && c && "text" in c
                  ? String((c as { text: unknown }).text)
                  : ""
              )
              .join("")
          : ""
    switch (scenario.kind) {
      case "echo":
        return `[mock-anthropic-echo${scenario.suffix ? `:${scenario.suffix}` : ""}] ${userText}`
      case "canned":
        return scenario.text
      case "json":
        return JSON.stringify(scenario.payload)
      case "stream-text":
        return scenario.chunks.join("")
      default:
        return ""
    }
  }

  // ── POST /v1/messages ────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/v1/messages", (req: any, res: any) => {
    const body = req.body as MessagesRequestPayload
    messagesCalls.push(body)
    for (const r of messagesResolvers.slice()) {
      if (messagesCalls.length >= r.count) {
        r.resolve()
        const i = messagesResolvers.indexOf(r)
        if (i !== -1) messagesResolvers.splice(i, 1)
      }
    }

    switch (scenario.kind) {
      case "rate-limited":
        res.set("retry-after", String(scenario.retryAfterSeconds ?? 1))
        res
          .status(429)
          .json({ type: "error", error: { type: "rate_limit_error", message: "rate-limited" } })
        return
      case "overloaded":
        res
          .status(529)
          .json({ type: "error", error: { type: "overloaded_error", message: "overloaded" } })
        return
      case "auth-error":
        res
          .status(401)
          .json({
            type: "error",
            error: { type: "authentication_error", message: "invalid api key" },
          })
        return
      case "server-error":
        res
          .status(scenario.status)
          .json({ type: "error", error: { type: "api_error", message: scenario.message } })
        return
      case "stream-text": {
        // Server-sent events stream framing.
        res.set("content-type", "text/event-stream")
        res.set("cache-control", "no-cache")
        res.set("connection", "keep-alive")
        res.flushHeaders?.()
        const id = `msg_${Math.random().toString(36).slice(2, 10)}`
        res.write(`event: message_start\n`)
        res.write(
          `data: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`
        )
        res.write(`event: content_block_start\n`)
        res.write(
          `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`
        )
        for (const chunk of scenario.chunks) {
          res.write(`event: content_block_delta\n`)
          res.write(
            `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } })}\n\n`
          )
        }
        res.write(`event: content_block_stop\n`)
        res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`)
        res.write(`event: message_delta\n`)
        res.write(
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: scenario.chunks.join("").length } })}\n\n`
        )
        res.write(`event: message_stop\n`)
        res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`)
        res.end()
        return
      }
      default: {
        const text = renderText(body)
        const out: MessagesResponse = {
          id: `msg_${Math.random().toString(36).slice(2, 10)}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: Math.max(1, Math.ceil(text.length / 4)),
            output_tokens: text.length,
          },
        }
        res.json(out)
      }
    }
  })

  // ── POST /v1/embeddings (OpenAI-style, used by the AI SDK shim) ──────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/v1/embeddings", (req: any, res: any) => {
    const body = req.body as { model: string; input: string | string[] }
    embeddingsCalls.push(body)
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    const out: EmbeddingResponse = {
      object: "list",
      data: inputs.map((_, i) => ({
        object: "embedding",
        embedding: embeddingVector.slice(),
        index: i,
      })),
      model: body.model,
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    }
    res.json(out)
  })

  return {
    async start(port = 0): Promise<void> {
      await new Promise<void>((resolve) => {
        server = app.listen(port, () => {
          const addr = server!.address()
          _port = typeof addr === "object" && addr ? addr.port : port
          resolve()
        })
      })
    },
    async stop(): Promise<void> {
      if (!server) return
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()))
      })
      server = null
    },
    get port() {
      return _port
    },
    get baseUrl() {
      return `http://127.0.0.1:${_port}`
    },
    setMessagesScenario(next) {
      scenario = next
    },
    setEmbeddingVector(vector) {
      embeddingVector = vector.slice()
    },
    waitForMessages(count, timeoutMs = 5_000) {
      if (messagesCalls.length >= count) return Promise.resolve(messagesCalls.slice(0, count))
      return new Promise<MessagesRequestPayload[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = messagesResolvers.findIndex((r) => r.count === count)
          if (i !== -1) messagesResolvers.splice(i, 1)
          reject(new Error(`waitForMessages(${count}) timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        messagesResolvers.push({
          count,
          resolve: () => {
            clearTimeout(timer)
            resolve(messagesCalls.slice(0, count))
          },
        })
      })
    },
    get messagesCalls() {
      return messagesCalls
    },
    get embeddingsCalls() {
      return embeddingsCalls
    },
    reset() {
      scenario = { kind: "echo" }
      embeddingVector = Array.from({ length: 16 }, (_, i) => (i + 1) / 16)
      messagesCalls.length = 0
      embeddingsCalls.length = 0
      messagesResolvers.length = 0
    },
  }
}
