import { invoke } from "@tauri-apps/api/core"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"

const mockDispatchConnectorCallback = jest.fn().mockResolvedValue(undefined)
const mockGetAdapterInstance = jest.fn().mockResolvedValue(undefined)
const mockAppendAudit = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({
    dispatchConnectorCallback: (...args: unknown[]) => mockDispatchConnectorCallback(...args),
  }),
}))

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: (...args: unknown[]) => mockGetAdapterInstance(...args),
  // at-gate → sibling-bots pulls this in; keep it inert for these tests.
  listAdapterInstancesByType: jest.fn().mockResolvedValue([]),
}))

jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: (...args: unknown[]) => mockAppendAudit(...args),
}))

import { createTelegramAdapter } from "./index"

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
    mockDispatchConnectorCallback.mockClear()
    mockAppendAudit.mockClear()
    mockGetAdapterInstance.mockReset()
    mockGetAdapterInstance.mockResolvedValue(undefined)
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
    // Composite "chatId:messageId" — message-scoped ops (delete / edit /
    // reactions) need both halves back (audited fix #1).
    expect(result.platformMessageId).toBe("111:888")

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

  it("declares transportMode in the config schema (audited fix #14)", () => {
    const adapter = createTelegramAdapter({
      id: "tg-schema",
      displayName: "Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "1",
    })
    const schema = adapter.meta.configSchema as {
      properties: Record<string, { enum?: string[] }>
    }
    expect(schema.properties.transportMode).toBeDefined()
    expect(schema.properties.transportMode.enum).toEqual(["longpoll", "webhook"])
    expect(schema.properties.secretToken).toBeDefined()
  })
})

describe("createTelegramAdapter — health degradation (audited fix #9)", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockGetAdapterInstance.mockReset()
    mockGetAdapterInstance.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function makeErrBody(code: number, description: string) {
    return {
      status: code,
      headers: {},
      body: JSON.stringify({ ok: false, error_code: code, description }),
    }
  }

  it("degrades with a reason on 401 and recovers to running on the next success", async () => {
    jest.useFakeTimers()
    mockInvoke
      .mockResolvedValueOnce(makeErrBody(401, "Unauthorized"))
      .mockResolvedValueOnce(makeOkUpdateResp([]))
      .mockImplementation(() => new Promise(() => {})) // stall further polls

    const adapter = createTelegramAdapter({
      id: "tg-health-401",
      displayName: "Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "1",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    // First poll (401) settles on the microtask queue.
    await jest.advanceTimersByTimeAsync(0)
    expect(adapter.health().state).toBe("degraded")
    expect(adapter.health().reason).toContain("401")
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "telegram:longpoll degraded",
      expect.objectContaining({ status: 401 })
    )

    // Ride out the reconnect backoff → second poll succeeds → recovered.
    await jest.advanceTimersByTimeAsync(60_000)
    expect(adapter.health().state).toBe("running")
    expect(adapter.health().reason).toBeUndefined()

    await adapter.stop()
  })

  it("degrades immediately on 409 getUpdates conflict", async () => {
    jest.useFakeTimers()
    mockInvoke
      .mockResolvedValueOnce(makeErrBody(409, "Conflict: terminated by other getUpdates"))
      .mockImplementation(() => new Promise(() => {}))

    const adapter = createTelegramAdapter({
      id: "tg-health-409",
      displayName: "Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "1",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await jest.advanceTimersByTimeAsync(0)

    expect(adapter.health().state).toBe("degraded")
    expect(adapter.health().reason).toContain("409")
    await adapter.stop()
  })

  it("stays running on a single transient error, degrades after 3 consecutive", async () => {
    jest.useFakeTimers()
    mockInvoke
      .mockResolvedValueOnce(makeErrBody(500, "boom-1"))
      .mockResolvedValueOnce(makeErrBody(500, "boom-2"))
      .mockResolvedValueOnce(makeErrBody(500, "boom-3"))
      .mockImplementation(() => new Promise(() => {}))

    const adapter = createTelegramAdapter({
      id: "tg-health-5xx",
      displayName: "Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "1",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    await jest.advanceTimersByTimeAsync(0)
    // one failure — still running (transient)
    expect(adapter.health().state).toBe("running")

    // after the 3rd consecutive failure the adapter degrades
    await jest.advanceTimersByTimeAsync(300_000)
    expect(adapter.health().state).toBe("degraded")
    expect(adapter.health().reason).toContain("3 consecutive")
    await adapter.stop()
  })
})

describe("createTelegramAdapter — callback chat gate (audited fix #12)", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockDispatchConnectorCallback.mockClear()
    mockAppendAudit.mockClear()
    mockGetAdapterInstance.mockReset()
  })

  function makeCallbackUpdate(chatId: number) {
    return {
      update_id: 900,
      callback_query: {
        id: "cq_1",
        from: { id: 7, first_name: "Ada" },
        message: {
          message_id: 55,
          chat: { id: chatId, type: "group" as const, title: "Grp" },
          date: 1,
          text: "pick one",
        },
        data: "a2ui:s1:c1:submit",
      },
    }
  }

  async function startWithUpdate(update: unknown, adapterId: string) {
    let pollCount = 0
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "connectors_http_request") return undefined
      const url = (args as { req?: { url?: string } } | undefined)?.req?.url ?? ""
      // answerCallbackQuery ACK responds immediately; polls after the first stall.
      if (url.includes("answerCallbackQuery")) return makeSendOkResp(0)
      pollCount += 1
      if (pollCount === 1) return makeOkUpdateResp([update])
      return await new Promise(() => {})
    })
    const adapter = createTelegramAdapter({
      id: adapterId,
      displayName: "Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "1",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await new Promise((r) => setTimeout(r, 30))
    return adapter
  }

  it("blocks callback_query from a blocklisted chat and audits the block", async () => {
    mockGetAdapterInstance.mockResolvedValue({
      id: "tg-gate-1",
      type: "telegram",
      chatBlocklist: ["-500"],
    })

    const adapter = await startWithUpdate(makeCallbackUpdate(-500), "tg-gate-1")
    expect(mockDispatchConnectorCallback).not.toHaveBeenCalled()
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "inbound.policy_blocked", reason: "chat_blocklist" })
    )
    await adapter.stop()
  })

  it("blocks callback_query outside a non-empty allowlist", async () => {
    mockGetAdapterInstance.mockResolvedValue({
      id: "tg-gate-2",
      type: "telegram",
      chatAllowlist: ["123"],
    })

    const adapter = await startWithUpdate(makeCallbackUpdate(-500), "tg-gate-2")
    expect(mockDispatchConnectorCallback).not.toHaveBeenCalled()
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "inbound.policy_blocked", reason: "chat_allowlist" })
    )
    await adapter.stop()
  })

  it("dispatches callback_query from an allowed chat", async () => {
    mockGetAdapterInstance.mockResolvedValue({
      id: "tg-gate-3",
      type: "telegram",
      chatAllowlist: ["-500"],
    })

    const adapter = await startWithUpdate(makeCallbackUpdate(-500), "tg-gate-3")
    expect(mockDispatchConnectorCallback).toHaveBeenCalledTimes(1)
    expect(mockDispatchConnectorCallback).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "telegram", value: "a2ui:s1:c1:submit" })
    )
    await adapter.stop()
  })

  it("dispatches callback_query when no row is configured (fail open)", async () => {
    mockGetAdapterInstance.mockResolvedValue(undefined)

    const adapter = await startWithUpdate(makeCallbackUpdate(-500), "tg-gate-4")
    expect(mockDispatchConnectorCallback).toHaveBeenCalledTimes(1)
    await adapter.stop()
  })
})
