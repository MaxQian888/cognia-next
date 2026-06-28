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
  | { kind: "stream-text"; chunks: string[]; delayMs?: number }

export type OauthScenario =
  | {
      kind: "granted"
      accessToken?: string
      refreshToken?: string
      expiresIn?: number
      email?: string
      plan?: string
    }
  | { kind: "invalid-grant" }
  | { kind: "server-error"; status: number; message: string }

export interface OauthTokenRequest {
  grantType: string
  code?: string
  refreshToken?: string
  codeVerifier?: string
  clientId?: string
  redirectUri?: string
}

export interface MockAnthropicServer {
  start(port?: number): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string

  setMessagesScenario(scenario: MessagesScenario): void
  /** Set the embedding vector returned by /v1/embeddings calls. */
  setEmbeddingVector(vector: number[]): void
  /** Configure the response shape for /v1/oauth/token. Defaults to `granted`. */
  setOauthScenario(scenario: OauthScenario): void

  /** Wait until N message calls have been captured. */
  waitForMessages(count: number, timeoutMs?: number): Promise<MessagesRequestPayload[]>
  /** All /v1/messages payloads captured so far. */
  readonly messagesCalls: MessagesRequestPayload[]
  /** All /v1/embeddings payloads captured so far. */
  readonly embeddingsCalls: Array<{ model: string; input: string | string[] }>
  /** All /v1/oauth/token payloads captured so far. */
  readonly oauthCalls: OauthTokenRequest[]
  /** Reset captured calls + scenario back to echo. */
  reset(): void
}

/**
 * Write one Anthropic Messages SSE response carrying `chunks` as text deltas.
 * Shared by the explicit `stream-text` scenario AND any request that sets
 * `stream: true` (the Claude Agent SDK / claude-code CLI the chat sidecar
 * spawns always streams), so the real chat path can consume this same mock.
 */
async function writeMessagesSse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res: any,
  chunks: string[],
  model: string,
  delayMs = 0
): Promise<void> {
  // Track a client-side disconnect so an aborted stream (the interrupt path
  // tears down the sidecar's HTTP request mid-flight) stops writing instead of
  // throwing `ERR_STREAM_WRITE_AFTER_END` on the dead socket.
  let aborted = false
  res.on?.("close", () => {
    aborted = true
  })
  res.set("content-type", "text/event-stream")
  res.set("cache-control", "no-cache")
  res.set("connection", "keep-alive")
  res.flushHeaders?.()
  const id = `msg_${Math.random().toString(36).slice(2, 10)}`
  res.write(`event: message_start\n`)
  res.write(
    `data: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`
  )
  res.write(`event: content_block_start\n`)
  res.write(
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`
  )
  for (const chunk of chunks) {
    // A per-chunk delay keeps the turn streaming long enough for the interrupt
    // spec to catch the live "streaming" state and click Stop.
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (aborted || res.writableEnded) return
    res.write(`event: content_block_delta\n`)
    res.write(
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } })}\n\n`
    )
  }
  if (aborted || res.writableEnded) return
  res.write(`event: content_block_stop\n`)
  res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`)
  res.write(`event: message_delta\n`)
  res.write(
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: chunks.join("").length } })}\n\n`
  )
  res.write(`event: message_stop\n`)
  res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`)
  res.end()
}

export function createMockAnthropicServer(): MockAnthropicServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = createExpressApp() as any
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require("express") as typeof import("express")
  app.use(express.json({ limit: "8mb" }))
  // OAuth token endpoint speaks application/x-www-form-urlencoded — the
  // anthropic OAuth module posts the body as form-encoded per the upstream
  // platform.claude.com behaviour.
  app.use(express.urlencoded({ extended: true, limit: "1mb" }))

  let server: Server | null = null
  let _port = 0
  let scenario: MessagesScenario = { kind: "echo" }
  let oauthScenario: OauthScenario = { kind: "granted" }
  let embeddingVector: number[] = Array.from({ length: 16 }, (_, i) => (i + 1) / 16)
  const messagesCalls: MessagesRequestPayload[] = []
  const embeddingsCalls: Array<{ model: string; input: string | string[] }> = []
  const oauthCalls: OauthTokenRequest[] = []
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
  app.post("/v1/messages", async (req: any, res: any) => {
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
        res.status(401).json({
          type: "error",
          error: { type: "authentication_error", message: "invalid api key" },
        })
        return
      case "server-error":
        res
          .status(scenario.status)
          .json({ type: "error", error: { type: "api_error", message: scenario.message } })
        return
    }

    // Non-error scenarios: echo / canned / json / stream-text. The chat sidecar
    // (Claude Agent SDK CLI) always sets `stream: true`; the workflow ai.*
    // executors call non-streaming. Serve SSE for either an explicit
    // `stream-text` scenario OR any streaming request, so ONE shared mock backs
    // both the chat path and the workflow path.
    const wantsStream = body.stream === true
    if (scenario.kind === "stream-text") {
      await writeMessagesSse(res, scenario.chunks, body.model, scenario.delayMs ?? 0)
      return
    }
    const text = renderText(body)
    if (wantsStream) {
      await writeMessagesSse(res, [text], body.model)
      return
    }
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
  })

  // ── POST /v1/oauth/token (form-encoded; PKCE exchange + refresh) ─────────
  // The anthropic OAuth module redirects here when the E2E renderer publishes
  // `window.__cogniaMockBaseUrls.anthropic` — both the `authorization_code`
  // exchange and refresh paths land at the same endpoint upstream.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/v1/oauth/token", (req: any, res: any) => {
    const body = req.body as Record<string, string | undefined>
    const captured: OauthTokenRequest = {
      grantType: String(body.grant_type ?? ""),
      code: body.code,
      refreshToken: body.refresh_token,
      codeVerifier: body.code_verifier,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
    }
    oauthCalls.push(captured)

    switch (oauthScenario.kind) {
      case "invalid-grant":
        res
          .status(400)
          .json({ error: "invalid_grant", error_description: "authorization code expired" })
        return
      case "server-error":
        res
          .status(oauthScenario.status)
          .json({ error: "server_error", error_description: oauthScenario.message })
        return
      case "granted":
      default: {
        const out = {
          access_token:
            oauthScenario.kind === "granted" && oauthScenario.accessToken
              ? oauthScenario.accessToken
              : `mock-anthropic-access-${Math.random().toString(36).slice(2, 10)}`,
          refresh_token:
            oauthScenario.kind === "granted" && oauthScenario.refreshToken
              ? oauthScenario.refreshToken
              : `mock-anthropic-refresh-${Math.random().toString(36).slice(2, 10)}`,
          expires_in:
            oauthScenario.kind === "granted" && typeof oauthScenario.expiresIn === "number"
              ? oauthScenario.expiresIn
              : 8 * 3600,
          scope: "user:profile user:inference user:sessions:claude_code",
          account: {
            email:
              oauthScenario.kind === "granted" && oauthScenario.email
                ? oauthScenario.email
                : "mock-user@example.com",
            uuid: "00000000-0000-0000-0000-000000000001",
            plan:
              oauthScenario.kind === "granted" && oauthScenario.plan
                ? oauthScenario.plan
                : "claude_pro",
          },
        }
        res.json(out)
        return
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

  const doReset = (): void => {
    scenario = { kind: "echo" }
    oauthScenario = { kind: "granted" }
    embeddingVector = Array.from({ length: 16 }, (_, i) => (i + 1) / 16)
    messagesCalls.length = 0
    embeddingsCalls.length = 0
    oauthCalls.length = 0
    messagesResolvers.length = 0
  }

  // ── Control plane (E2E-only) ─────────────────────────────────────────────
  // The shared instance booted in global-setup is pointed at by the Tauri
  // sidecar via ANTHROPIC_BASE_URL, but its in-process handle is NOT exported
  // to specs. These endpoints let a spec (running in the Playwright node
  // process) mutate the SAME instance over HTTP — drive an error/slow-stream
  // scenario for the real chat path, then reset it so the next test sees echo.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/__control/messages-scenario", (req: any, res: any) => {
    scenario = req.body as MessagesScenario
    res.json({ ok: true })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/__control/reset", (_req: any, res: any) => {
    doReset()
    res.json({ ok: true })
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
    setOauthScenario(next) {
      oauthScenario = next
    },
    get oauthCalls() {
      return oauthCalls
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
      doReset()
    },
  }
}
