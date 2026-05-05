import { invoke } from "@tauri-apps/api/core"
import { createTelegramAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"

const mockInvoke = invoke as jest.Mock

function makeOkUpdateResp(updates: unknown[]) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, result: updates }),
  }
}

function makeSendOkResp(messageId = 999) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, result: { message_id: messageId } }),
  }
}

function makeUpdate(id: number) {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 111, first_name: "Alice" },
      chat: { id: 111, type: "private" },
      date: 1000000,
      text: `hello ${id}`,
    },
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
    adapterId: "tg-test",
  }
  return { ctx, emitted }
}

describe("createTelegramAdapter", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it("exposes correct meta", () => {
    const adapter = createTelegramAdapter({
      id: "tg-1",
      displayName: "My Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "987654321",
    })

    expect(adapter.id).toBe("tg-1")
    expect(adapter.meta.type).toBe("telegram")
    expect(adapter.meta.displayName).toBe("My Bot")
    expect(adapter.meta.version).toBe("0.1.0")
    expect(adapter.meta.transportModes).toContain("longpoll")
    expect(adapter.meta.capabilities).toContain("send.text")
  })

  it("health() starts as 'starting'", () => {
    const adapter = createTelegramAdapter({
      id: "tg-1",
      displayName: "My Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "987654321",
    })
    expect(adapter.health().state).toBe("starting")
  })

  it("start() drives updates and emits parsed events", async () => {
    // The mock resolves with one update, then the adapter is stopped before
    // the next poll. We resolve the stop via a flag.
    let pollCount = 0
    mockInvoke.mockImplementation(async () => {
      pollCount += 1
      if (pollCount === 1) {
        return makeOkUpdateResp([makeUpdate(1)])
      }
      // Stall subsequent polls until the test is done
      await new Promise((r) => setTimeout(r, 50000))
      return makeOkUpdateResp([])
    })

    const adapter = createTelegramAdapter({
      id: "tg-2",
      displayName: "Test Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "987654321",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)

    // Wait for first poll to complete
    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].messageId).toBe("1")
  })

  it("send() calls the correct Telegram API method", async () => {
    mockInvoke.mockResolvedValue(makeSendOkResp(888))

    const adapter = createTelegramAdapter({
      id: "tg-3",
      displayName: "Test Bot",
      transport: "longpoll",
      botToken: async () => "MY_TOKEN",
      selfId: "987654321",
    })

    const req = {
      conversationRef: { platform: "telegram" as const, adapterId: "tg-3", chatId: "111" },
      segments: [{ type: "text" as const, text: "Hello world" }],
      metadata: { idempotencyKey: "key-1" },
    }

    const result = await adapter.send(req)

    expect(result.ok).toBe(true)
    expect(result.platformMessageId).toBe("888")

    // Verify the invoke call
    expect(mockInvoke).toHaveBeenCalledWith("connectors_http_request", {
      req: expect.objectContaining({
        url: "https://api.telegram.org/botMY_TOKEN/sendMessage",
        method: "POST",
      }),
    })
  })

  it("health() is 'running' after start()", async () => {
    mockInvoke.mockResolvedValue(makeOkUpdateResp([]))

    const adapter = createTelegramAdapter({
      id: "tg-4",
      displayName: "Test Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "987654321",
    })

    const { ctx } = makeCtx()
    await adapter.start(ctx)
    expect(adapter.health().state).toBe("running")
    await adapter.stop()
  })

  it("health() is 'down' after stop()", async () => {
    mockInvoke.mockResolvedValue(makeOkUpdateResp([]))

    const adapter = createTelegramAdapter({
      id: "tg-5",
      displayName: "Test Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "987654321",
    })

    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await adapter.stop()
    expect(adapter.health().state).toBe("down")
  })
})
