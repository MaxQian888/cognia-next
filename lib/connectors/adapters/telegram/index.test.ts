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

import { setConnectorListen } from "@/lib/connectors/events"
import { TELEGRAM_ALLOWED_UPDATES } from "./allowed-updates"
const mockEnrich = jest.fn().mockResolvedValue(undefined)
jest.mock("./inbound-media", () => ({
  enrichTelegramInboundMedia: (...a: unknown[]) => mockEnrich(...a),
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
    mockEnrich.mockClear()
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

  it("resolves media before the event reaches the bus", async () => {
    // Without this the model receives the literal text `tg://file/<id>` in
    // place of the picture, and the inbound OCR pass never runs.
    let pollCount = 0
    mockInvoke.mockImplementation(async () => {
      pollCount += 1
      if (pollCount === 1) {
        return makeOkUpdateResp([
          {
            update_id: 1,
            message: {
              message_id: 1,
              from: { id: 111, first_name: "Alice" },
              chat: { id: 111, type: "private" },
              date: 1000000,
              photo: [{ file_id: "f1", file_unique_id: "u1", width: 10, height: 10 }],
            },
          },
        ])
      }
      await new Promise((r) => setTimeout(r, 50000))
      return makeOkUpdateResp([])
    })

    const adapter = createTelegramAdapter({
      id: "tg-media",
      displayName: "Test Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "987654321",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(emitted).toHaveLength(1)
    expect(mockEnrich).toHaveBeenCalledTimes(1)
    expect(mockEnrich.mock.calls[0][0]).toBe(emitted[0])
  })

  it("emits ONE event for an album instead of one per photo", async () => {
    // Three updates sharing a media_group_id — Telegram's only representation
    // of "here are three photos with a caption". Before this, the bot answered
    // three times and two of the three saw no caption at all.
    const album = [1, 2, 3].map((id) => ({
      update_id: id,
      message: {
        message_id: id,
        from: { id: 111, first_name: "Alice" },
        chat: { id: 111, type: "private" },
        date: 1000000,
        media_group_id: "mg-1",
        photo: [{ file_id: `f${id}`, file_unique_id: `u${id}`, width: 10, height: 10 }],
        ...(id === 2 ? { caption: "what are these" } : {}),
      },
    }))
    let pollCount = 0
    mockInvoke.mockImplementation(async () => {
      pollCount += 1
      if (pollCount === 1) return makeOkUpdateResp(album)
      await new Promise((r) => setTimeout(r, 50000))
      return makeOkUpdateResp([])
    })

    const adapter = createTelegramAdapter({
      id: "tg-album",
      displayName: "Test Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "987654321",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await new Promise((r) => setTimeout(r, 30))
    // stop() flushes the open group, so the assertion does not wait out the
    // album window.
    await adapter.stop()

    expect(emitted).toHaveLength(1)
    expect(emitted[0].messageId).toBe("1")
    // The caption rode on part 2 and still reaches the trigger matcher.
    expect(emitted[0].plainText).toContain("what are these")
    expect(emitted[0].segments.filter((s) => s.type === "image")).toHaveLength(3)
    expect(emitted[0].channelData?.telegramAlbum).toEqual({ messageIds: ["1", "2", "3"] })
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

/**
 * Webhook registration lifecycle.
 *
 * Before this existed the adapter subscribed to the local webhook event
 * channel and reported `running` without ever telling Telegram where to push,
 * so a bot that had never been registered by hand looked perfectly healthy and
 * received nothing. These tests pin the registration, the reasons it refuses,
 * and the retraction that makes a transport switch survivable.
 */
describe("createTelegramAdapter — webhook registration", () => {
  let restoreListen: ReturnType<typeof setConnectorListen> | null = null

  beforeEach(() => {
    mockInvoke.mockReset()
    mockAppendAudit.mockClear()
    // The transport's own subscription is not under test here; give it an
    // inert listener so `unlisten()` on abort has something to call.
    restoreListen = setConnectorListen(async () => () => {})
  })

  afterEach(() => {
    if (restoreListen) setConnectorListen(restoreListen)
    restoreListen = null
  })

  const httpOk = { status: 200, headers: {}, body: JSON.stringify({ ok: true, result: true }) }

  /**
   * Stand in for the Bot API. `getWebhookInfo` reflects the last successful
   * `setWebhook` the way the real API does, so the adapter's steady-state
   * probe agrees with itself unless a test deliberately says otherwise.
   */
  function installBotApi(
    over: {
      setWebhook?: { status: number; headers: Record<string, string>; body: string }
      info?: () => Record<string, unknown>
    } = {}
  ) {
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "connectors_http_request") return undefined
      const url = String((args as { req: { url: string } }).req.url)
      if (url.endsWith("/getWebhookInfo")) {
        const registered = botApiCalls("setWebhook").at(-1)?.url ?? ""
        const result = over.info?.() ?? { url: registered, pending_update_count: 0 }
        return { status: 200, headers: {}, body: JSON.stringify({ ok: true, result }) }
      }
      if (url.endsWith("/setWebhook") && over.setWebhook) return over.setWebhook
      return httpOk
    })
  }

  function botApiCalls(method: string): Record<string, unknown>[] {
    return mockInvoke.mock.calls
      .filter(
        ([cmd, args]) =>
          cmd === "connectors_http_request" &&
          String((args as { req: { url: string } }).req.url).endsWith(`/${method}`)
      )
      .map(([, args]) => JSON.parse((args as { req: { body: string } }).req.body))
  }

  /** Poll until `predicate` holds; the registration runs detached from start(). */
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  function makeWebhookCtx(secret: Record<string, string | null> = { secretToken: "s3cret" }) {
    const { ctx } = makeCtx()
    ;(ctx.tauri.publicBaseUrl as jest.Mock).mockResolvedValue(null)
    ;(ctx.secrets.get as jest.Mock).mockImplementation(async (name: string) => secret[name] ?? null)
    ;(ctx.secrets.set as jest.Mock).mockResolvedValue(undefined)
    return ctx
  }

  function makeWebhookAdapter(
    over: Partial<Parameters<typeof createTelegramAdapter>[0]> = {},
    tunnelUrl: () => Promise<string | null> = async () => "https://tunnel.example.com"
  ) {
    return createTelegramAdapter({
      id: "tg-wh",
      displayName: "Webhook Bot",
      transport: "webhook",
      botToken: async () => "TOKEN",
      selfId: "987",
      webhookEnvironment: { isDesktop: () => true, tunnelUrl, publicBase: () => null },
      ...over,
    })
  }

  it("registers the tunnel-derived URL with the secret and the shared allowed_updates", async () => {
    installBotApi()
    const ctx = makeWebhookCtx()
    const adapter = makeWebhookAdapter()

    await adapter.start(ctx)
    await waitFor(() => botApiCalls("setWebhook").length === 1, "setWebhook")

    expect(botApiCalls("setWebhook")[0]).toEqual({
      url: "https://tunnel.example.com/webhook/telegram/tg-wh",
      secret_token: "s3cret",
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      drop_pending_updates: false,
    })
    expect(adapter.health().state).toBe("running")
    await adapter.stop()
  })

  it("long-poll adapters never call setWebhook", async () => {
    // Stall after the first poll — a getUpdates mock that keeps resolving spins
    // the loop hot (Telegram's own long-poll timeout is what paces it).
    let polls = 0
    mockInvoke.mockImplementation(async () => {
      polls += 1
      if (polls === 1)
        return { status: 200, headers: {}, body: JSON.stringify({ ok: true, result: [] }) }
      return await new Promise(() => {})
    })
    const { ctx } = makeCtx()
    const adapter = createTelegramAdapter({
      id: "tg-lp",
      displayName: "Poll Bot",
      transport: "longpoll",
      botToken: async () => "TOKEN",
      selfId: "987",
    })

    await adapter.start(ctx)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(botApiCalls("setWebhook")).toHaveLength(0)
    await adapter.stop()
  })

  it("degrades with an actionable reason when no public URL is reachable", async () => {
    installBotApi()
    const ctx = makeWebhookCtx()
    const adapter = makeWebhookAdapter({}, async () => null)

    await adapter.start(ctx)
    await waitFor(() => adapter.health().state === "degraded", "degraded health")

    expect(adapter.health().reason).toMatch(/no publicly reachable HTTPS URL/)
    expect(botApiCalls("setWebhook")).toHaveLength(0)
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "adapter.error", reason: "webhook_registration_failed" })
    )
    await adapter.stop()
  })

  it("refuses to register when no webhook secret is configured", async () => {
    // The Rust receiver 401s every delivery that arrives without a secret, so
    // registering here would point Telegram at a URL that rejects it.
    installBotApi()
    const ctx = makeWebhookCtx({ secretToken: null, webhookSecret: null })
    const adapter = makeWebhookAdapter()

    await adapter.start(ctx)
    await waitFor(() => adapter.health().state === "degraded", "degraded health")

    expect(adapter.health().reason).toMatch(/no webhook secret is configured/)
    expect(botApiCalls("setWebhook")).toHaveLength(0)
    await adapter.stop()
  })

  it("migrates a legacy webhookSecret onto the key the receiver reads", async () => {
    installBotApi()
    const ctx = makeWebhookCtx({ secretToken: null, webhookSecret: "legacy-secret" })
    const adapter = makeWebhookAdapter()

    await adapter.start(ctx)
    await waitFor(() => botApiCalls("setWebhook").length === 1, "setWebhook")

    expect(ctx.secrets.set).toHaveBeenCalledWith("secretToken", "legacy-secret")
    expect(botApiCalls("setWebhook")[0].secret_token).toBe("legacy-secret")
    await adapter.stop()
  })

  it("degrades when Telegram rejects setWebhook", async () => {
    installBotApi({
      setWebhook: {
        status: 400,
        headers: {},
        body: JSON.stringify({ ok: false, description: "Bad webhook: failed to resolve host" }),
      },
    })
    const ctx = makeWebhookCtx()
    const adapter = makeWebhookAdapter()

    await adapter.start(ctx)
    await waitFor(() => adapter.health().state === "degraded", "degraded health")

    expect(adapter.health().reason).toMatch(/setWebhook failed:.*failed to resolve host/)
    await adapter.stop()
  })

  it("re-registers when the tunnel hostname rotates", async () => {
    // A Cloudflared quick tunnel gets a new hostname on every restart; the
    // registration made at boot points nowhere from that moment on.
    installBotApi()
    let host = "https://first.trycloudflare.com"
    const ctx = makeWebhookCtx()
    const adapter = makeWebhookAdapter({ _webhookRecheckMs: 5 }, async () => host)

    await adapter.start(ctx)
    await waitFor(() => botApiCalls("setWebhook").length === 1, "first setWebhook")

    // Steady state costs no API calls at all.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(botApiCalls("setWebhook")).toHaveLength(1)

    host = "https://second.trycloudflare.com"
    await waitFor(() => botApiCalls("setWebhook").length === 2, "re-registration")
    expect(botApiCalls("setWebhook")[1].url).toBe(
      "https://second.trycloudflare.com/webhook/telegram/tg-wh"
    )
    await adapter.stop()
  })

  it("retracts the registration on stop so a switch to long poll is not 409'd", async () => {
    installBotApi()
    const ctx = makeWebhookCtx()
    const adapter = makeWebhookAdapter()

    await adapter.start(ctx)
    await waitFor(() => botApiCalls("setWebhook").length === 1, "setWebhook")
    await adapter.stop()

    expect(botApiCalls("deleteWebhook")).toEqual([{ drop_pending_updates: false }])
  })

  it("degrades when Telegram reports that deliveries are failing", async () => {
    // setWebhook returning ok proves the URL parsed, nothing more. A tunnel
    // pointed at the wrong local port registers cleanly and then 404s every
    // push — which from in here is indistinguishable from an idle bot.
    installBotApi({
      info: () => ({
        url: "https://tunnel.example.com/webhook/telegram/tg-wh",
        pending_update_count: 3,
        last_error_message: "Wrong response from the webhook: 404 Not Found",
      }),
    })
    const ctx = makeWebhookCtx()
    const adapter = makeWebhookAdapter({ _webhookRecheckMs: 5 })

    await adapter.start(ctx)
    await waitFor(() => adapter.health().state === "degraded", "delivery degradation")

    expect(adapter.health().reason).toMatch(/deliveries are failing.*404 Not Found/)
    expect(adapter.health().reason).toMatch(/3 update\(s\) queued/)
    await adapter.stop()
  })

  it("recovers once deliveries start landing again", async () => {
    let failing = true
    installBotApi({
      info: () => ({
        url: "https://tunnel.example.com/webhook/telegram/tg-wh",
        pending_update_count: failing ? 3 : 0,
        ...(failing ? { last_error_message: "Connection timed out" } : {}),
      }),
    })
    const ctx = makeWebhookCtx()
    const adapter = makeWebhookAdapter({ _webhookRecheckMs: 5 })

    await adapter.start(ctx)
    await waitFor(() => adapter.health().state === "degraded", "delivery degradation")
    failing = false
    await waitFor(() => adapter.health().state === "running", "recovery")

    expect(adapter.health().reason).toBeUndefined()
    await adapter.stop()
  })

  it("re-registers when the registration was cleared out from under it", async () => {
    let cleared = true
    installBotApi({
      info: () =>
        cleared
          ? { url: "", pending_update_count: 0 }
          : { url: "https://tunnel.example.com/webhook/telegram/tg-wh", pending_update_count: 0 },
    })
    const ctx = makeWebhookCtx()
    const adapter = makeWebhookAdapter({ _webhookRecheckMs: 5 })

    await adapter.start(ctx)
    await waitFor(() => botApiCalls("setWebhook").length >= 2, "re-registration")
    cleared = false

    expect(botApiCalls("setWebhook")[1].url).toBe(
      "https://tunnel.example.com/webhook/telegram/tg-wh"
    )
    await adapter.stop()
  })

  it("does not retract a registration it never made", async () => {
    installBotApi()
    const ctx = makeWebhookCtx({ secretToken: null })
    const adapter = makeWebhookAdapter()

    await adapter.start(ctx)
    await waitFor(() => adapter.health().state === "degraded", "degraded health")
    await adapter.stop()

    expect(botApiCalls("deleteWebhook")).toHaveLength(0)
  })
})
