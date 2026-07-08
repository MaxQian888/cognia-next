/**
 * @jest-environment jsdom
 */

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { createSlackAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"

const mockInvoke = invoke as jest.Mock
const mockListen = listen as jest.Mock

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

  it("health() is 'running' after start()", async () => {
    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    expect(adapter.health().state).toBe("running")
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
    expect(adapter.health().state).toBe("running")
    await adapter.stop()
  })

  it("start() sets health to degraded when transport=socket-mode but no appToken", async () => {
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
    expect(adapter.health().state).toBe("degraded")
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

    // Send hello to set up connection
    session.push({ type: "hello", num_connections: 1 })
    await new Promise((r) => setTimeout(r, 20))

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
    expect(result.platformMessageId).toBe("1234.5678")

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
