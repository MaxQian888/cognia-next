/**
 * @jest-environment jsdom
 */

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getBus } from "@/lib/connectors/bus"
import { createSlackAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"

jest.mock("@/lib/connectors/bus", () => {
  const dispatchConnectorCallback = jest.fn()
  return { getBus: () => ({ dispatchConnectorCallback }) }
})

jest.mock("@/lib/file/file-operations", () => ({ statFile: jest.fn() }))

import { statFile } from "@/lib/file/file-operations"

const mockInvoke = invoke as jest.Mock
const mockListen = listen as jest.Mock
const mockDispatchCallback = getBus().dispatchConnectorCallback as jest.Mock
const mockStatFile = statFile as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSendOkResp(ts = "1234567890.123456") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, ts }),
  }
}

function makeErrResp(status = 400, errorCode = "channel_not_found") {
  return {
    status,
    headers: {},
    body: JSON.stringify({ ok: false, error: errorCode }),
  }
}

function makeCtx(): { ctx: AdapterContext; emitted: NormalizedInboundEvent[] } {
  const emitted: NormalizedInboundEvent[] = []
  const ctx: AdapterContext = {
    emit: jest.fn(async (e: NormalizedInboundEvent) => {
      emitted.push(e)
    }),
    tauri: {
      httpRequest: jest.fn(),
      openWs: jest.fn(),
      fetchAttachment: jest.fn(),
      bindWebhookRoute: jest.fn(),
      unbindWebhookRoute: jest.fn(),
      publicBaseUrl: jest.fn(),
    },
    secrets: {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
    },
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    signal: new AbortController().signal,
    adapterId: "sl-test",
  }
  return { ctx, emitted }
}

function makeAdapter(transport: "socket-mode" | "events-api-webhook" = "socket-mode") {
  return createSlackAdapter({
    id: "sl-1",
    displayName: "My Slack Bot",
    botToken: async () => "xoxb-test-token",
    appToken: async () => "xapp-test-token",
    signingSecret: async () => "signing-secret",
    selfId: "UBOT123",
    transport,
  })
}

describe("runtime capabilities", () => {
  it("gates assistant-only presentation features without disabling live steering", () => {
    const basic = makeAdapter()
    expect(basic.runPresentation).toBeUndefined()
    expect(basic.runtimeCapabilities).toEqual(
      expect.objectContaining({
        liveSteer: true,
        textStreaming: false,
        componentMutation: false,
        suggestedPrompts: false,
      })
    )

    const assistant = createSlackAdapter({
      id: "sl-assistant",
      displayName: "Assistant Bot",
      botToken: async () => "xoxb-test-token",
      signingSecret: async () => "signing-secret",
      selfId: "UBOT123",
      transport: "socket-mode",
      assistantAppEnabled: true,
    })
    expect(assistant.runPresentation).toBeDefined()
    expect(assistant.runtimeCapabilities).toEqual(
      expect.objectContaining({
        liveSteer: true,
        textStreaming: true,
        componentMutation: true,
        suggestedPrompts: true,
      })
    )
  })
})

// ---------------------------------------------------------------------------
// Fake socket-mode session
// ---------------------------------------------------------------------------

function createFakeSocketModeSession() {
  let messageHandler: ((event: { payload: string }) => void) | null = null
  let closeHandler: (() => void) | null = null
  let listenCallCount = 0
  let handlersResolve: () => void = () => {}
  const handlersReadyP = new Promise<void>((r) => {
    handlersResolve = r
  })

  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    listenCallCount++
    if ((eventName as string).endsWith("/message")) {
      messageHandler = handler as (event: { payload: string }) => void
    } else if ((eventName as string).endsWith("/close")) {
      closeHandler = handler as () => void
    }
    if (listenCallCount >= 2) handlersResolve()
    return jest.fn()
  })

  return {
    listenImpl,
    waitForListeners: () => handlersReadyP,
    push(payload: unknown) {
      messageHandler?.({ payload: JSON.stringify(payload) })
    },
    triggerClose() {
      closeHandler?.()
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSlackAdapter", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockListen.mockReset()
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_ws_open") return "ws-handle-id"
      if (cmd === "connectors_ws_send") return undefined
      if (cmd === "connectors_ws_close") return undefined
      return makeSendOkResp()
    })
    mockListen.mockResolvedValue(jest.fn())
    mockDispatchCallback.mockReset()
    mockStatFile.mockReset()
  })

  it("exposes correct meta", () => {
    const adapter = makeAdapter()
    expect(adapter.id).toBe("sl-1")
    expect(adapter.meta.type).toBe("slack")
    expect(adapter.meta.displayName).toBe("My Slack Bot")
    expect(adapter.meta.version).toBe("0.1.0")
    expect(adapter.meta.transportModes).toContain("gateway")
    expect(adapter.meta.capabilities).toContain("send.text")
  })

  it("exposes webhook transport mode for events-api-webhook", () => {
    const adapter = makeAdapter("events-api-webhook")
    expect(adapter.meta.transportModes).toContain("webhook")
  })

  it("health() starts as 'starting'", () => {
    const adapter = makeAdapter()
    expect(adapter.health().state).toBe("starting")
  })

  it("health() stays 'starting' after start() until the first hello", async () => {
    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    // No hello frame has arrived — the connection is not confirmed yet.
    expect(adapter.health().state).toBe("starting")
    await adapter.stop()
  })

  it("health() is 'down' after stop()", async () => {
    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await adapter.stop()
    expect(adapter.health().state).toBe("down")
  })

  it("start() is idempotent (second call is no-op)", async () => {
    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await adapter.start(ctx) // second call
    expect(adapter.health().state).toBe("starting")
    await adapter.stop()
  })

  it("start() sets health to degraded with a reason when socket-mode lacks an appToken", async () => {
    const adapter = createSlackAdapter({
      id: "sl-no-app",
      displayName: "No App Token",
      botToken: async () => "xoxb-token",
      signingSecret: async () => "secret",
      selfId: "UBOT",
      transport: "socket-mode",
      // appToken intentionally omitted
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    const health = adapter.health()
    expect(health.state).toBe("degraded")
    expect(health.reason).toMatch(/app-level token/)
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("missing app token"),
      expect.objectContaining({ adapterId: "sl-no-app" })
    )
  })

  it("start() with events-api-webhook stays running (stub)", async () => {
    const adapter = makeAdapter("events-api-webhook")
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    expect(adapter.health().state).toBe("running")
    await adapter.stop()
  })

  it("start() drives socket-mode events and emits parsed events", async () => {
    const session = createFakeSocketModeSession()
    mockListen.mockImplementation(session.listenImpl)

    // First invoke: apps.connections.open returns a WSS URL
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_ws_open") return "ws-handle-x"
      if (cmd === "connectors_ws_send") return undefined
      if (cmd === "connectors_ws_close") return undefined
      if (cmd === "connectors_http_request") {
        // First HTTP call is apps.connections.open
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=x" }),
        }
      }
      return makeSendOkResp()
    })

    const adapter = createSlackAdapter({
      id: "sl-evt",
      displayName: "Event Test Bot",
      botToken: async () => "xoxb-token",
      appToken: async () => "xapp-token",
      signingSecret: async () => "secret",
      selfId: "UBOT999",
      transport: "socket-mode",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)

    await session.waitForListeners()
    expect(adapter.health().state).toBe("starting")

    // Send hello to set up connection
    session.push({ type: "hello", num_connections: 1 })
    await new Promise((r) => setTimeout(r, 20))
    // hello confirms the connection — health flips to running.
    expect(adapter.health().state).toBe("running")

    // Send an events_api frame with a message event
    session.push({
      type: "events_api",
      envelope_id: "env-abc",
      accepts_response_payload: false,
      payload: {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C01234567",
          user: "U0987654",
          text: "hello from slack",
          ts: "1600000000.000001",
          channel_type: "channel",
        },
        team_id: "T123",
        api_app_id: "A456",
      },
    })

    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].platform).toBe("slack")
    expect(emitted[0].messageId).toBe("1600000000.000001")
  }, 15000)

  it("routes socket-mode interactive envelopes to the bus callback channel", async () => {
    const session = createFakeSocketModeSession()
    mockListen.mockImplementation(session.listenImpl)
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_ws_open") return "ws-handle-i"
      if (cmd === "connectors_ws_send") return undefined
      if (cmd === "connectors_ws_close") return undefined
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=i" }),
      }
    })

    const adapter = makeAdapter()
    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({ type: "hello" })
    await new Promise((r) => setTimeout(r, 10))
    session.push({
      type: "interactive",
      envelope_id: "env-int-1",
      payload: {
        type: "block_actions",
        user: { id: "U777" },
        container: { channel_id: "C01", message_ts: "1600000009.000001" },
        actions: [{ action_id: "a2ui:s1:c1:go", type: "button", value: "go" }],
      },
    })
    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    // Interactive payloads become bus callbacks — not message events.
    expect(emitted).toHaveLength(0)
    expect(mockDispatchCallback).toHaveBeenCalledTimes(1)
    expect(mockDispatchCallback.mock.calls[0][0]).toMatchObject({
      platform: "slack",
      triggerId: "a2ui:s1:c1:go",
      actionType: "button",
      value: "go",
    })
  }, 15000)

  it("routes socket-mode slash_commands as normalized inbound text events", async () => {
    const session = createFakeSocketModeSession()
    mockListen.mockImplementation(session.listenImpl)
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_ws_open") return "ws-handle-s"
      if (cmd === "connectors_ws_send") return undefined
      if (cmd === "connectors_ws_close") return undefined
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=s" }),
      }
    })

    const adapter = makeAdapter()
    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({ type: "hello" })
    await new Promise((r) => setTimeout(r, 10))
    session.push({
      type: "slash_commands",
      envelope_id: "env-slash-1",
      payload: {
        command: "/cognia",
        text: "summarize this channel",
        channel_id: "C0SLASH",
        user_id: "U0SLASH",
        trigger_id: "trig-1",
      },
    })
    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(emitted).toHaveLength(1)
    expect(emitted[0].plainText).toBe("/cognia summarize this channel")
    expect(emitted[0].messageId).toBe("trig-1")
    expect(emitted[0].mentions.selfMentioned).toBe(true)
    expect(emitted[0].conversationKey).toBe("slack:sl-1:C0SLASH")
  }, 15000)

  it("routes webhook-delivered interactive payloads to handleInteractivePayload", async () => {
    let webhookHandler: ((event: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation(async (eventName: string, handler: unknown) => {
      if (eventName === "connectors://webhook/sl-1") {
        webhookHandler = handler as (event: { payload: unknown }) => void
      }
      return jest.fn()
    })

    const adapter = makeAdapter("events-api-webhook")
    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await new Promise((r) => setTimeout(r, 10))
    expect(webhookHandler).not.toBeNull()

    // Interactive payload (decoded `payload=` JSON, emitted by Rust).
    webhookHandler!({
      payload: {
        type: "block_actions",
        user: { id: "U888" },
        container: { channel_id: "C02", message_ts: "1600000010.000001" },
        actions: [{ action_id: "a2ui:s2:c2:ok", type: "button", value: "ok" }],
      },
    })
    // Ordinary event envelope still parses as a message event.
    webhookHandler!({
      payload: {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C02",
          user: "U888",
          text: "via webhook",
          ts: "1600000011.000001",
          channel_type: "channel",
        },
      },
    })
    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(mockDispatchCallback).toHaveBeenCalledTimes(1)
    expect(mockDispatchCallback.mock.calls[0][0]).toMatchObject({
      triggerId: "a2ui:s2:c2:ok",
      actionType: "button",
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].plainText).toBe("via webhook")
  }, 15000)

  it("send() calls chat.postMessage with botToken", async () => {
    mockInvoke.mockResolvedValue(makeSendOkResp("1234.5678"))

    const adapter = makeAdapter()
    const req = {
      conversationRef: {
        platform: "slack" as const,
        adapterId: "sl-1",
        channelId: "C01CHANNEL",
      },
      segments: [{ type: "text" as const, text: "Hello Slack" }],
      metadata: { idempotencyKey: "k1" },
    }

    const result = await adapter.send(req)
    expect(result.ok).toBe(true)
    // Composite "<channelId>:<ts>" so edit/delete/reactions can re-derive
    // the channel from the platform message id alone.
    expect(result.platformMessageId).toBe("C01CHANNEL:1234.5678")

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    expect(httpCalls.length).toBeGreaterThan(0)
    const reqPayload = (
      httpCalls[0][1] as { req: { url: string; headers: Record<string, string> } }
    ).req
    expect(reqPayload.url).toContain("chat.postMessage")
    expect(reqPayload.headers["Authorization"]).toBe("Bearer xoxb-test-token")
  })

  it("send() returns error result when API returns 4xx", async () => {
    mockInvoke.mockResolvedValue(makeErrResp(200, "channel_not_found"))

    const adapter = makeAdapter()
    const req = {
      conversationRef: {
        platform: "slack" as const,
        adapterId: "sl-1",
        channelId: "INVALID",
      },
      segments: [{ type: "text" as const, text: "fail" }],
      metadata: { idempotencyKey: "k-err" },
    }

    // The mock returns ok:false which triggers the error path
    const result = await adapter.send(req)
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain("channel_not_found")
    // Permanent Slack error — must NOT retry forever.
    expect(result.error?.code).toBe("platform_4xx")
    expect(result.error?.retryable).toBe(false)
  })

  describe("send() error classification", () => {
    const req = {
      conversationRef: {
        platform: "slack" as const,
        adapterId: "sl-1",
        channelId: "C01",
      },
      segments: [{ type: "text" as const, text: "x" }],
      metadata: { idempotencyKey: "k-class" },
    }

    it("maps invalid_auth to a non-retryable auth_failed", async () => {
      mockInvoke.mockResolvedValue(makeErrResp(200, "invalid_auth"))
      const result = await makeAdapter().send(req)
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("auth_failed")
      expect(result.error?.retryable).toBe(false)
    })

    it.each(["msg_too_long", "is_archived", "restricted_action"])(
      "maps %s to a non-retryable platform_4xx",
      async (code) => {
        mockInvoke.mockResolvedValue(makeErrResp(200, code))
        const result = await makeAdapter().send(req)
        expect(result.error?.code).toBe("platform_4xx")
        expect(result.error?.retryable).toBe(false)
      }
    )

    it("maps missing_scope to a non-retryable auth_failed", async () => {
      mockInvoke.mockResolvedValue(makeErrResp(200, "missing_scope"))
      const result = await makeAdapter().send(req)
      expect(result.error?.code).toBe("auth_failed")
      expect(result.error?.retryable).toBe(false)
    })

    it("maps HTTP 429 to rate_limited honoring Retry-After", async () => {
      mockInvoke.mockResolvedValue({
        status: 429,
        headers: { "retry-after": "30" },
        body: JSON.stringify({ ok: false, error: "ratelimited" }),
      })
      const result = await makeAdapter().send(req)
      expect(result.error?.code).toBe("rate_limited")
      expect(result.error?.retryable).toBe(true)
      expect(result.error?.retryAfterMs).toBe(30_000)
    })

    it("keeps HTTP 5xx retryable as platform_5xx", async () => {
      mockInvoke.mockResolvedValue({ status: 502, headers: {}, body: "bad gateway" })
      const result = await makeAdapter().send(req)
      expect(result.error?.code).toBe("platform_5xx")
      expect(result.error?.retryable).toBe(true)
    })

    it("maps an all-empty request to a non-retryable validation error", async () => {
      const result = await makeAdapter().send({ ...req, segments: [] })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("validation")
      expect(result.error?.retryable).toBe(false)
      const httpCalls = mockInvoke.mock.calls.filter(
        ([cmd]: [string]) => cmd === "connectors_http_request"
      )
      expect(httpCalls).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // File uploads — files.getUploadURLExternal → byte POST → completeUploadExternal
  // ---------------------------------------------------------------------------

  describe("file uploads (external upload flow)", () => {
    const conversationRef = {
      platform: "slack" as const,
      adapterId: "sl-1",
      channelId: "C0UP",
      threadTs: "1600000000.000777",
    }

    /** Chronological list of upload-relevant calls: url or media-upload req. */
    function uploadCalls() {
      return mockInvoke.mock.calls
        .map(([cmd, args]: [string, Record<string, unknown>]) => {
          if (cmd === "connectors_media_upload") return { kind: "bytes", req: args.req }
          if (cmd === "connectors_http_request") {
            return { kind: "http", req: args.req as { url: string; body?: string } }
          }
          return null
        })
        .filter(Boolean) as Array<{
        kind: string
        req: { url?: string; body?: string } & Record<string, unknown>
      }>
    }

    function mockUploadApis(opts?: {
      openResp?: unknown
      bytesError?: string
      completeResp?: unknown
    }) {
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "connectors_media_upload") {
          if (opts?.bytesError) return Promise.reject(opts.bytesError)
          return ""
        }
        if (cmd === "connectors_http_request") {
          const url = (args as { req: { url: string } }).req.url
          if (url.includes("files.getUploadURLExternal")) {
            return {
              status: 200,
              headers: {},
              body: JSON.stringify(
                opts?.openResp ?? {
                  ok: true,
                  upload_url: "https://files.slack.com/upload/v1/CAFE01",
                  file_id: "F0EXAMPLE",
                }
              ),
            }
          }
          if (url.includes("files.completeUploadExternal")) {
            return {
              status: 200,
              headers: {},
              body: JSON.stringify(
                opts?.completeResp ?? { ok: true, files: [{ id: "F0EXAMPLE" }] }
              ),
            }
          }
          return makeSendOkResp("9999.0001")
        }
        return undefined
      })
    }

    const localFileSegment = {
      type: "file" as const,
      url: "file:///tmp/report%20final.pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
    }

    it("happy path: 3 calls in order with the documented params, no chat.postMessage", async () => {
      mockUploadApis()
      const result = await makeAdapter().send({
        conversationRef,
        segments: [localFileSegment],
        metadata: { idempotencyKey: "k-up1" },
      })

      expect(result.ok).toBe(true)
      // completeUploadExternal with channel_id already shared the file —
      // there is no chat.postMessage and thus no message ts.
      expect(result.platformMessageId).toBeUndefined()

      const calls = uploadCalls()
      expect(calls).toHaveLength(3)

      // Step 1 — files.getUploadURLExternal with required filename + length.
      const open = new URL(calls[0].req.url as string)
      expect(open.pathname).toContain("files.getUploadURLExternal")
      expect(open.searchParams.get("filename")).toBe("report.pdf")
      expect(open.searchParams.get("length")).toBe("1234")

      // Step 2 — raw bytes POSTed to upload_url via the media-upload command.
      expect(calls[1].kind).toBe("bytes")
      expect(calls[1].req).toEqual({
        uploadUrl: "https://files.slack.com/upload/v1/CAFE01",
        contentType: "application/pdf",
        localPath: "/tmp/report final.pdf",
      })

      // Step 3 — files.completeUploadExternal with files:[{id,title}] +
      // channel_id + thread_ts share.
      expect(calls[2].req.url).toContain("files.completeUploadExternal")
      expect(JSON.parse(calls[2].req.body as string)).toEqual({
        files: [{ id: "F0EXAMPLE", title: "report.pdf" }],
        channel_id: "C0UP",
        thread_ts: "1600000000.000777",
      })

      const postMessageCalls = mockInvoke.mock.calls.filter(
        ([cmd, args]: [string, { req?: { url?: string } }]) =>
          cmd === "connectors_http_request" && args.req?.url?.includes("chat.postMessage")
      )
      expect(postMessageCalls).toHaveLength(0)
    })

    it("mixed text + local image: posts the message first, stats the image for length", async () => {
      mockUploadApis()
      mockStatFile.mockResolvedValue({ size: 777 })

      const result = await makeAdapter().send({
        conversationRef,
        segments: [
          { type: "text", text: "see attachment" },
          { type: "image", url: "file:///tmp/shot.png", alt: "screenshot" },
        ],
        metadata: { idempotencyKey: "k-up2" },
      })

      expect(result.ok).toBe(true)
      // The text message posted normally and carries the composite id.
      expect(result.platformMessageId).toBe("C0UP:9999.0001")
      expect(mockStatFile).toHaveBeenCalledWith("/tmp/shot.png")

      const calls = uploadCalls()
      // chat.postMessage FIRST, then the 3-step upload.
      expect(calls[0].req.url).toContain("chat.postMessage")
      const open = new URL(calls[1].req.url as string)
      expect(open.searchParams.get("length")).toBe("777")
      expect(open.searchParams.get("filename")).toBe("screenshot")
      expect(calls[2].kind).toBe("bytes")
      expect(calls[3].req.url).toContain("files.completeUploadExternal")
    })

    it("remote http(s) file sources keep the link-block passthrough (no upload calls)", async () => {
      mockUploadApis()
      const result = await makeAdapter().send({
        conversationRef,
        segments: [
          {
            type: "file",
            url: "https://example.com/report.pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1234,
          },
        ],
        metadata: { idempotencyKey: "k-up3" },
      })
      expect(result.ok).toBe(true)
      const urls = uploadCalls().map((c) => c.req.url ?? "media-upload")
      expect(urls).toHaveLength(1)
      expect(urls[0]).toContain("chat.postMessage")
    })

    it("treats the upload_url's plain-text response ('OK - N') parse error as success", async () => {
      // The shared Rust command checks HTTP status < 400 BEFORE parsing the
      // body for Matrix's content_uri, so this error implies a successful POST.
      mockUploadApis({
        bytesError: "media upload response is not JSON: expected value; body=OK - 1234",
      })
      const result = await makeAdapter().send({
        conversationRef,
        segments: [localFileSegment],
        metadata: { idempotencyKey: "k-up4" },
      })
      expect(result.ok).toBe(true)
      expect(uploadCalls().map((c) => c.req.url ?? "bytes")).toEqual([
        expect.stringContaining("files.getUploadURLExternal"),
        "bytes",
        expect.stringContaining("files.completeUploadExternal"),
      ])
    })

    it("step-1 failure: file_upload_size_restricted → non-retryable validation", async () => {
      mockUploadApis({ openResp: { ok: false, error: "file_upload_size_restricted" } })
      const result = await makeAdapter().send({
        conversationRef,
        segments: [localFileSegment],
        metadata: { idempotencyKey: "k-up5" },
      })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("validation")
      expect(result.error?.retryable).toBe(false)
      // Never reached the byte POST.
      expect(uploadCalls().some((c) => c.kind === "bytes")).toBe(false)
    })

    it("step-2 failure: Rust byte-cap rejection → non-retryable validation", async () => {
      mockUploadApis({
        bytesError: "source media is 999999999 bytes, exceeding the 104857600-byte upload cap",
      })
      const result = await makeAdapter().send({
        conversationRef,
        segments: [localFileSegment],
        metadata: { idempotencyKey: "k-up6" },
      })
      expect(result.error?.code).toBe("validation")
      expect(result.error?.retryable).toBe(false)
    })

    it("step-2 failure: HTTP 413 from upload_url → validation; HTTP 500 → retryable platform_5xx", async () => {
      mockUploadApis({ bytesError: "media upload HTTP 413: payload too large" })
      const tooLarge = await makeAdapter().send({
        conversationRef,
        segments: [localFileSegment],
        metadata: { idempotencyKey: "k-up7" },
      })
      expect(tooLarge.error?.code).toBe("validation")
      expect(tooLarge.error?.retryable).toBe(false)

      mockUploadApis({ bytesError: "media upload HTTP 500: boom" })
      const transient = await makeAdapter().send({
        conversationRef,
        segments: [localFileSegment],
        metadata: { idempotencyKey: "k-up8" },
      })
      expect(transient.error?.code).toBe("platform_5xx")
      expect(transient.error?.retryable).toBe(true)
    })

    it("step-3 failure: channel_not_found from completeUploadExternal → platform_4xx", async () => {
      mockUploadApis({ completeResp: { ok: false, error: "channel_not_found" } })
      const result = await makeAdapter().send({
        conversationRef,
        segments: [localFileSegment],
        metadata: { idempotencyKey: "k-up9" },
      })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("platform_4xx")
      expect(result.error?.retryable).toBe(false)
    })

    it("unknown byte size (stat fails) → non-retryable validation naming `length`", async () => {
      mockUploadApis()
      mockStatFile.mockRejectedValue(new Error("scope denied"))
      const result = await makeAdapter().send({
        conversationRef,
        segments: [{ type: "image", url: "file:///tmp/unknown.png" }],
        metadata: { idempotencyKey: "k-up10" },
      })
      expect(result.error?.code).toBe("validation")
      expect(result.error?.message).toMatch(/length/)
    })

    it("uploadFile() uploads privately (no channel_id) and returns the file_id", async () => {
      mockUploadApis()
      const ref = await makeAdapter().uploadFile!({
        url: "file:///tmp/a.png",
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 10,
      })
      expect(ref).toEqual({ localUrl: "file:///tmp/a.png", remoteRef: "F0EXAMPLE" })
      const complete = uploadCalls().find((c) =>
        (c.req.url ?? "").includes("files.completeUploadExternal")
      )
      expect(JSON.parse(complete!.req.body as string)).toEqual({
        files: [{ id: "F0EXAMPLE", title: "a.png" }],
      })
    })
  })

  it("setTyping() is a no-op (returns without calling API)", async () => {
    const adapter = makeAdapter()
    await adapter.setTyping!("slack:sl-1:C01", true)
    await adapter.setTyping!("slack:sl-1:C01", false)

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    expect(httpCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // setSuggestedPrompts — assistant-thread escape hatch (plugins / workflows
  // drive it via `bus.listAdapters().find(...).setSuggestedPrompts(...)`).
  // -------------------------------------------------------------------------

  describe("presence", () => {
    function httpCalls() {
      return mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === "connectors_http_request")
    }

    it("setPresenceStatus posts users.profile.set with the user token", async () => {
      const adapter = createSlackAdapter({
        id: "sl-1",
        displayName: "Bot",
        botToken: async () => "xoxb-test-token",
        signingSecret: async () => "secret",
        userToken: async () => "xoxp-user-token",
        selfId: "UBOT123",
        transport: "socket-mode",
      })
      await adapter.setPresenceStatus!({ text: "AI 1.2M $3.4", expiresAt: 1_800_000_000_000 })
      const [, args] = httpCalls()[0]
      const req = (args as { req: { url: string; headers: Record<string, string>; body: string } })
        .req
      expect(req.url).toContain("users.profile.set")
      expect(req.headers.Authorization).toBe("Bearer xoxp-user-token")
      const body = JSON.parse(req.body) as {
        profile: { status_text: string; status_expiration: number }
      }
      expect(body.profile.status_text).toBe("AI 1.2M $3.4")
      expect(body.profile.status_expiration).toBe(1_800_000_000)
    })

    it("setPresenceStatus throws without a user token", async () => {
      const adapter = makeAdapter()
      await expect(adapter.setPresenceStatus!({ text: "AI" })).rejects.toThrow(/user token/)
      expect(httpCalls()).toHaveLength(0)
    })

    it("pinMessage posts pins.add with channel + timestamp", async () => {
      const adapter = makeAdapter()
      await adapter.pinMessage!("slack:sl-1:C01", "1600000000.000100")
      const [, args] = httpCalls()[0]
      const req = (args as { req: { url: string; body: string } }).req
      expect(req.url).toContain("pins.add")
      expect(JSON.parse(req.body)).toEqual({ channel: "C01", timestamp: "1600000000.000100" })
    })
  })

  describe("setSuggestedPrompts", () => {
    type WithSuggested = ReturnType<typeof createSlackAdapter> & {
      setSuggestedPrompts: (
        conversationKey: string,
        prompts: Array<{ title: string; message: string }>,
        title?: string
      ) => Promise<void>
    }

    function makeAssistantAdapter() {
      return createSlackAdapter({
        id: "sl-1",
        displayName: "Assistant Bot",
        botToken: async () => "xoxb-test-token",
        appToken: async () => "xapp-test-token",
        signingSecret: async () => "signing-secret",
        selfId: "UBOT123",
        transport: "socket-mode",
        assistantAppEnabled: true,
      }) as WithSuggested
    }

    const prompts = [{ title: "Summarise", message: "Summarise this thread" }]

    function httpCalls() {
      return mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === "connectors_http_request")
    }

    it("is a no-op when assistantAppEnabled is false", async () => {
      const adapter = makeAdapter() as WithSuggested
      await adapter.setSuggestedPrompts("slack:sl-1:C01:1600000000.000100", prompts)
      expect(httpCalls()).toHaveLength(0)
    })

    it("is a no-op when the conversation has no thread_ts", async () => {
      const adapter = makeAssistantAdapter()
      await adapter.setSuggestedPrompts("slack:sl-1:C01", prompts)
      expect(httpCalls()).toHaveLength(0)
    })

    it("POSTs assistant.threads.setSuggestedPrompts for an assistant thread", async () => {
      const adapter = makeAssistantAdapter()
      await adapter.setSuggestedPrompts("slack:sl-1:C01:1600000000.000100", prompts, "Try")

      const calls = httpCalls()
      expect(calls).toHaveLength(1)
      const reqPayload = (
        calls[0][1] as { req: { url: string; headers: Record<string, string>; body?: string } }
      ).req
      expect(reqPayload.url).toContain("assistant.threads.setSuggestedPrompts")
      expect(reqPayload.headers["Authorization"]).toBe("Bearer xoxb-test-token")
      const body = JSON.parse(reqPayload.body ?? "{}") as Record<string, unknown>
      expect(body.channel_id).toBe("C01")
      expect(body.thread_ts).toBe("1600000000.000100")
      expect(body.prompts).toEqual(prompts)
      expect(body.title).toBe("Try")
    })
  })

  it("fetchHistory() calls conversations.history and yields parsed messages", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "connectors_http_request") return undefined
      const req = (args as { req: { url: string } }).req
      if (req.url.includes("conversations.history")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            ok: true,
            messages: [
              {
                type: "message",
                user: "U123",
                text: "from history",
                ts: "1700000000.000001",
                channel_type: "channel",
              },
            ],
            response_metadata: { next_cursor: "" },
          }),
        }
      }
      return makeSendOkResp()
    })

    const adapter = makeAdapter()
    const events: NormalizedInboundEvent[] = []
    for await (const evt of adapter.fetchHistory!("slack:sl-1:C01", {
      before: "1700000001.000000",
      after: "1699999999.000000",
    })) {
      events.push(evt)
    }
    expect(events).toHaveLength(1)
    expect(events[0].messageId).toBe("1700000000.000001")
    expect(events[0].plainText).toBe("from history")

    const historyCall = mockInvoke.mock.calls.find(
      ([cmd, args]: [string, { req?: { url?: string } }]) =>
        cmd === "connectors_http_request" && args.req?.url?.includes("conversations.history")
    )
    expect(historyCall).toBeDefined()
    const url = new URL((historyCall![1] as { req: { url: string } }).req.url)
    expect(url.searchParams.get("channel")).toBe("C01")
    expect(url.searchParams.get("limit")).toBe("200")
    expect(url.searchParams.get("latest")).toBe("1700000001.000000")
    expect(url.searchParams.get("oldest")).toBe("1699999999.000000")
  })

  it("refreshCredentials() resolves without error", async () => {
    const adapter = makeAdapter()
    await expect(adapter.refreshCredentials!()).resolves.toBeUndefined()
  })
})
