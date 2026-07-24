/**
 * @jest-environment jsdom
 */

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { createLarkAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"

const mockInvoke = invoke as jest.Mock
const mockListen = listen as jest.Mock

// Inbound rich-media enrichment is exercised in its own suite
// (inbound-media.test.ts). Here we only assert the adapter WIRES it into the
// dispatch path — mock it to a no-op spy so no real download is attempted.
const mockEnrich = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./menu-actions", () => ({
  handleMenuUnknownKey: jest.fn(async () => undefined),
  handleMenuDisabledKey: jest.fn(async () => undefined),
  handleMenuLink: jest.fn(async () => undefined),
}))

jest.mock("./inbound-media", () => ({
  __esModule: true,
  enrichLarkInboundMedia: (...args: unknown[]) => mockEnrich(...args),
}))

// Registry seeding runs at adapter start. Its own behavior lives in
// principal/bootstrap.test.ts; here we only prove the adapter CALLS it, since
// an unwired bootstrap is exactly the failure this seam exists to prevent.
const mockBootstrap = jest.fn(async () => ({ status: "skipped", reason: "flag_off" }) as const)
jest.mock("@/lib/connectors/principal/bootstrap", () => ({
  __esModule: true,
  bootstrapFeishuRegistry: (...args: unknown[]) => mockBootstrap(...(args as [])),
}))

const mockGetAdapterInstance = jest.fn(async (_id: string) => undefined as unknown)
jest.mock("@/lib/db/adapter-instances", () => ({
  __esModule: true,
  getAdapterInstance: (id: string) => mockGetAdapterInstance(id),
  patchAdapterInstanceSettings: jest.fn(async () => undefined),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTatOkResp(token = "t-tat-test") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, tenant_access_token: token, expire: 7200 }),
  }
}

function makeSendOkResp() {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, data: { message_id: "om_resp_001" } }),
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
    adapterId: "lark-test",
  }
  return { ctx, emitted }
}

function makeAdapter(transport: "webhook" | "long-connection" = "long-connection") {
  return createLarkAdapter({
    id: "lark-1",
    displayName: "My Lark Bot",
    appId: async () => "cli_app_001",
    appSecret: async () => "app-secret-001",
    verificationToken: async () => "verify-token-001",
    selfBotOpenId: "ou_bot_self_001",
    transport,
  })
}

// ---------------------------------------------------------------------------
// Fake long-connection WS session
// ---------------------------------------------------------------------------

function createFakeLongConnSession() {
  let messageHandler: ((event: { payload: string }) => void) | null = null
  let closeHandler: (() => void) | null = null
  let listenCallCount = 0
  let handlersResolve: () => void = () => {}
  const handlersReadyP = new Promise<void>((r) => {
    handlersResolve = r
  })

  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    listenCallCount++
    if ((eventName as string).endsWith("/event")) {
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

describe("createLarkAdapter", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockListen.mockReset()
    mockEnrich.mockClear()
    mockBootstrap.mockClear()
    mockGetAdapterInstance.mockReset()
    mockGetAdapterInstance.mockResolvedValue(undefined)
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_lark_ws_open") return "lark-ws-handle"
      if (cmd === "connectors_lark_ws_close") return undefined
      if (cmd === "connectors_http_request") return makeTatOkResp()
      return undefined
    })
    mockListen.mockResolvedValue(jest.fn())
  })

  it("exposes correct meta for long-connection", () => {
    const adapter = makeAdapter("long-connection")
    expect(adapter.id).toBe("lark-1")
    expect(adapter.meta.type).toBe("lark")
    expect(adapter.meta.displayName).toBe("My Lark Bot")
    expect(adapter.meta.version).toBe("0.1.0")
    expect(adapter.meta.transportModes).toContain("gateway")
    expect(adapter.meta.capabilities).toContain("send.text")
  })

  it("exposes webhook transport mode for webhook", () => {
    const adapter = makeAdapter("webhook")
    expect(adapter.meta.transportModes).toContain("webhook")
  })

  it("wires the five chat-management methods, paired with their capability flags (W2)", () => {
    const adapter = makeAdapter()
    // Methods present on the adapter surface…
    expect(typeof adapter.createChat).toBe("function")
    expect(typeof adapter.addChatMembers).toBe("function")
    expect(typeof adapter.removeChatMembers).toBe("function")
    expect(typeof adapter.updateChat).toBe("function")
    expect(typeof adapter.resolveContacts).toBe("function")
    // …and the paired flags declared in meta.capabilities.
    for (const cap of ["chat.create", "chat.members", "chat.update", "contact.resolve"]) {
      expect(adapter.meta.capabilities).toContain(cap)
    }
  })

  it("health() starts as 'starting'", () => {
    const adapter = makeAdapter()
    expect(adapter.health().state).toBe("starting")
  })

  // start() only proves credentials resolved — "running" needs evidence the
  // transport actually delivers (first envelope) or the API works (first
  // successful send). Previously health flipped to running immediately and
  // a bot whose long-conn never connected still reported healthy.
  it("health() stays 'starting' right after start() (no traffic yet)", async () => {
    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    expect(adapter.health().state).toBe("starting")
    expect(adapter.health().reason).toBeUndefined()
    await adapter.stop()
  })

  it("seeds the Feishu principal registry at start with the adapter's own row", async () => {
    const row = {
      id: "lark-1",
      settings: { larkPrincipalRegistry: true },
      lastWhoamiResult: { botName: "b", appId: "cli_app_001", openId: "ou_bot", tenantKey: "tk_a" },
    }
    // Not `…Once`: the chat-surface sweep fires first and reads the same row.
    mockGetAdapterInstance.mockResolvedValue(row)
    const adapter = makeAdapter()
    const { ctx } = makeCtx()

    await adapter.start(ctx)
    // The call is fire-and-forget behind an async adapter-row read; let the
    // task queue drain rather than guessing a microtask count.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockBootstrap).toHaveBeenCalledWith({ adapterId: "lark-1", adapterRow: row })
    await adapter.stop()
  })

  it("skips registry seeding when the adapter row is missing", async () => {
    mockGetAdapterInstance.mockResolvedValue(undefined)
    const adapter = makeAdapter()
    const { ctx } = makeCtx()

    await adapter.start(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockBootstrap).not.toHaveBeenCalled()
    await adapter.stop()
  })

  it("health() flips to 'running' on the first inbound envelope", async () => {
    const session = createFakeLongConnSession()
    mockListen.mockImplementation(session.listenImpl)
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_lark_ws_open") return "lark-ws-h"
      return undefined
    })

    const adapter = createLarkAdapter({
      id: "lark-health-evt",
      displayName: "Health Bot",
      appId: async () => "cli_health",
      appSecret: async () => "secret-health",
      verificationToken: async () => "token",
      selfBotOpenId: "ou_bot",
      transport: "long-connection",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()
    expect(adapter.health().state).toBe("starting")

    session.push({
      schema: "2.0",
      header: { event_id: "evt_h1", event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_user_h" } },
        message: {
          message_id: "om_h1",
          chat_id: "oc_chat_h",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"ping"}',
        },
      },
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(adapter.health().state).toBe("running")
    expect(adapter.health().reason).toBeUndefined()
    expect(adapter.health().lastActivityAt).toBeDefined()
    await adapter.stop()
  }, 15000)

  it("health() goes 'degraded' with transport_error when the transport throws", async () => {
    // listen() rejecting makes the long-conn generator throw — the only
    // transport failure signal observable on the TS side (Rust owns the
    // per-cycle reconnect loop).
    mockListen.mockRejectedValue(new Error("tauri event bridge gone"))
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_lark_ws_open") return "lark-ws-broken"
      return undefined
    })
    const errorSpy = jest
      .spyOn((await import("@cognia/logging")).loggers.network, "error")
      .mockImplementation(() => {})
    try {
      const adapter = createLarkAdapter({
        id: "lark-health-deg",
        displayName: "Degraded Bot",
        appId: async () => "cli_deg",
        appSecret: async () => "secret-deg",
        verificationToken: async () => "token",
        selfBotOpenId: "ou_bot",
        transport: "long-connection",
      })
      const { ctx } = makeCtx()
      await adapter.start(ctx)
      await new Promise((r) => setTimeout(r, 30))
      expect(adapter.health().state).toBe("degraded")
      expect(adapter.health().reason).toBe("transport_error")
      await adapter.stop()
    } finally {
      errorSpy.mockRestore()
    }
  }, 15000)

  it("health() is 'down' after stop()", async () => {
    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await adapter.stop()
    expect(adapter.health().state).toBe("down")
  })

  it("start() skips adapters with empty appId/appSecret (no doomed reconnect loop)", async () => {
    const adapter = createLarkAdapter({
      id: "lark-empty",
      displayName: "Unconfigured Bot",
      appId: async () => "",
      appSecret: async () => "",
      verificationToken: async () => "",
      selfBotOpenId: "ou_bot",
      transport: "long-connection",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    // Give any (incorrectly-started) async transport loop a tick to fire.
    await new Promise((r) => setTimeout(r, 20))
    // Skipped cleanly: health is 'down' and the Rust WS open command never ran.
    expect(adapter.health().state).toBe("down")
    // The reason is surfaced to the UI so a "silent bot" is diagnosable.
    expect(adapter.health().reason).toBe("credentials_missing")
    const openCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_lark_ws_open"
    )
    expect(openCalls).toHaveLength(0)
  })

  it("start() skips (warns, never errors) when credential lookup throws", async () => {
    // A keyring read that throws (e.g. OS denies access to a not-yet-
    // configured adapter) must be handled as gracefully as empty creds:
    // health 'down', no Rust WS open, and a non-alarming warn — NOT a red
    // network ERROR that re-fires on every boot.
    const { loggers } = await import("@cognia/logging")
    const warnSpy = jest.spyOn(loggers.network, "warn").mockImplementation(() => {})
    const errorSpy = jest.spyOn(loggers.network, "error").mockImplementation(() => {})
    try {
      const adapter = createLarkAdapter({
        id: "lark-keyring-denied",
        displayName: "Keyring-Denied Bot",
        appId: async () => {
          throw new Error("keyring read failed: access denied")
        },
        appSecret: async () => "",
        verificationToken: async () => "",
        selfBotOpenId: "ou_bot",
        transport: "long-connection",
      })
      const { ctx } = makeCtx()
      await expect(adapter.start(ctx)).resolves.toBeUndefined()
      await new Promise((r) => setTimeout(r, 20))
      expect(adapter.health().state).toBe("down")
      expect(adapter.health().reason).toBe("credentials_unavailable")
      const openCalls = mockInvoke.mock.calls.filter(
        ([cmd]: [string]) => cmd === "connectors_lark_ws_open"
      )
      expect(openCalls).toHaveLength(0)
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        "[lark] adapter skipped — credentials unavailable",
        expect.objectContaining({
          id: "lark-keyring-denied",
          reason: "keyring read failed: access denied",
        })
      )
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("start() is idempotent (second call is no-op)", async () => {
    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await adapter.start(ctx)
    expect(adapter.health().state).toBe("starting")
    // Exactly one transport open despite two start() calls.
    const openCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_lark_ws_open"
    )
    expect(openCalls.length).toBeLessThanOrEqual(1)
    await adapter.stop()
  })

  it("start() drives long-connection events and emits parsed events", async () => {
    const session = createFakeLongConnSession()
    mockListen.mockImplementation(session.listenImpl)

    mockInvoke.mockImplementation(async (cmd: string) => {
      // The long-connection handshake + protobuf framing now live in Rust; the
      // TS side only opens a handle and listens on the lark-ws event channel.
      if (cmd === "connectors_lark_ws_open") return "lark-ws-x"
      if (cmd === "connectors_lark_ws_close") return undefined
      return undefined
    })

    const adapter = createLarkAdapter({
      id: "lark-evt",
      displayName: "Event Test Bot",
      appId: async () => "cli_app_evt",
      appSecret: async () => "secret-evt",
      verificationToken: async () => "token-evt",
      selfBotOpenId: "ou_bot_evt",
      transport: "long-connection",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)

    await session.waitForListeners()

    session.push({
      schema: "2.0",
      header: { event_id: "evt_001", event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_user_001" } },
        message: {
          message_id: "om_evt_001",
          chat_id: "oc_chat_001",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"hello from lark"}',
          create_time: "1714900000000",
        },
      },
    })

    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].platform).toBe("lark")
    expect(emitted[0].messageId).toBe("om_evt_001")
  }, 15000)

  it("runs inbound rich-media enrichment on the emitted event before dispatch", async () => {
    const session = createFakeLongConnSession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createLarkAdapter({
      id: "lark-img",
      displayName: "Image Test Bot",
      appId: async () => "cli_app_img",
      appSecret: async () => "secret-img",
      verificationToken: async () => "token-img",
      selfBotOpenId: "ou_bot_img",
      transport: "long-connection",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({
      schema: "2.0",
      header: { event_id: "evt_img", event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_user_img" } },
        message: {
          message_id: "om_img_1",
          chat_id: "oc_chat_img",
          chat_type: "p2p",
          message_type: "image",
          content: '{"image_key":"img_v3_xyz"}',
          create_time: "1714900000000",
        },
      },
    })

    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    // Enrichment ran on the parsed event before it was emitted to the bus.
    expect(mockEnrich).toHaveBeenCalledTimes(1)
    const enrichedEvent = mockEnrich.mock.calls[0][0] as unknown as NormalizedInboundEvent
    expect(enrichedEvent.messageId).toBe("om_img_1")
    expect(enrichedEvent.segments[0]).toMatchObject({ type: "image", url: "img_v3_xyz" })
    expect(emitted.length).toBeGreaterThanOrEqual(1)
  }, 15000)

  it("maps a bot-menu (快捷指令) click to its configured action", async () => {
    const session = createFakeLongConnSession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createLarkAdapter({
      id: "lark-menu",
      displayName: "Menu Test Bot",
      appId: async () => "cli_menu",
      appSecret: async () => "secret-menu",
      verificationToken: async () => "token-menu",
      selfBotOpenId: "ou_bot_menu",
      quickCommands: [{ triggerKey: "agenda", action: { type: "slash", value: "/agenda today" } }],
      transport: "long-connection",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({
      schema: "2.0",
      header: { event_id: "evt_menu_1", event_type: "application.bot.menu_v6" },
      event: {
        operator: { operator_id: { open_id: "ou_user_777" } },
        event_key: "agenda",
      },
    })

    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].plainText).toBe("/agenda today")
    expect(emitted[0].conversationRef.channelId).toBe("ou_user_777")
  }, 15000)

  it("routes an unmapped bot-menu click to the terminal unknown handler, not the bus", async () => {
    const menuActions = jest.requireMock("./menu-actions") as {
      handleMenuUnknownKey: jest.Mock
      handleMenuLink: jest.Mock
    }
    menuActions.handleMenuUnknownKey.mockClear()
    const session = createFakeLongConnSession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createLarkAdapter({
      id: "lark-menu-unknown",
      displayName: "Menu Test Bot",
      appId: async () => "cli_menu",
      appSecret: async () => "secret-menu",
      verificationToken: async () => "token-menu",
      selfBotOpenId: "ou_bot_menu",
      quickCommands: [{ triggerKey: "agenda", action: { type: "slash", value: "/agenda today" } }],
      transport: "long-connection",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({
      schema: "2.0",
      header: { event_id: "evt_menu_2", event_type: "application.bot.menu_v6" },
      event: {
        operator: { operator_id: { open_id: "ou_user_777" } },
        event_key: "never_configured",
      },
    })

    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(emitted).toHaveLength(0)
    expect(menuActions.handleMenuUnknownKey).toHaveBeenCalledTimes(1)
    expect(menuActions.handleMenuUnknownKey.mock.calls[0][1]).toMatchObject({
      kind: "unknown",
      eventKey: "never_configured",
      openId: "ou_user_777",
    })
  }, 15000)

  it("gates reserved cognia.* built-ins on the larkNativeSlash batch flag", async () => {
    const menuActions = jest.requireMock("./menu-actions") as {
      handleMenuUnknownKey: jest.Mock
      handleMenuDisabledKey: jest.Mock
    }
    const reservedClick = {
      schema: "2.0",
      header: { event_id: "evt_menu_3", event_type: "application.bot.menu_v6" },
      event: {
        operator: { operator_id: { open_id: "ou_user_777" } },
        event_key: "cognia.new_task",
      },
    }
    const makeAdapter = (id: string) =>
      createLarkAdapter({
        id,
        displayName: "Menu Test Bot",
        appId: async () => "cli_menu",
        appSecret: async () => "secret-menu",
        verificationToken: async () => "token-menu",
        selfBotOpenId: "ou_bot_menu",
        transport: "long-connection",
      })

    // Flag off (default): the recognized reserved click terminates as disabled.
    menuActions.handleMenuUnknownKey.mockClear()
    menuActions.handleMenuDisabledKey.mockClear()
    let session = createFakeLongConnSession()
    mockListen.mockImplementation(session.listenImpl)
    let adapter = makeAdapter("lark-menu-batch-off")
    let { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()
    session.push(reservedClick)
    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()
    expect(emitted).toHaveLength(0)
    expect(menuActions.handleMenuUnknownKey).not.toHaveBeenCalled()
    expect(menuActions.handleMenuDisabledKey).toHaveBeenCalledWith(
      "lark-menu-batch-off",
      expect.objectContaining({ openId: "ou_user_777", eventId: "evt_menu_3" })
    )

    // Flag on (env layer): the reserved slash runs through the normal path.
    process.env.COGNIA_LARK_NATIVE_SLASH = "1"
    try {
      menuActions.handleMenuUnknownKey.mockClear()
      menuActions.handleMenuDisabledKey.mockClear()
      session = createFakeLongConnSession()
      mockListen.mockImplementation(session.listenImpl)
      adapter = makeAdapter("lark-menu-batch-on")
      ;({ ctx, emitted } = makeCtx())
      await adapter.start(ctx)
      await session.waitForListeners()
      session.push(reservedClick)
      await new Promise((r) => setTimeout(r, 30))
      await adapter.stop()
      expect(menuActions.handleMenuUnknownKey).not.toHaveBeenCalled()
      expect(menuActions.handleMenuDisabledKey).not.toHaveBeenCalled()
      expect(emitted.length).toBeGreaterThanOrEqual(1)
      expect(emitted[0].plainText).toBe("/new")
    } finally {
      delete process.env.COGNIA_LARK_NATIVE_SLASH
    }
  }, 15000)

  it("send() acquires TAT and calls Lark API", async () => {
    // Use fresh appId/appSecret so the cache won't already have a token
    const adapter = createLarkAdapter({
      id: "lark-send-test",
      displayName: "Send Test Bot",
      appId: async () => "cli_send_unique",
      appSecret: async () => "secret_send_unique",
      verificationToken: async () => "token",
      selfBotOpenId: "ou_bot",
      transport: "long-connection",
    })

    mockInvoke
      .mockResolvedValueOnce(makeTatOkResp("t-send-tat")) // TAT fetch
      .mockResolvedValueOnce(makeSendOkResp()) // message send

    const req = {
      conversationRef: {
        platform: "lark" as const,
        adapterId: "lark-send-test",
        channelId: "oc_chat_001",
      },
      segments: [{ type: "text" as const, text: "Hello Lark" }],
      metadata: { idempotencyKey: "k1" },
    }

    expect(adapter.health().lastActivityAt).toBeUndefined()
    const result = await adapter.send(req)
    expect(result.ok).toBe(true)
    // Delivery feedback: the REAL Lark message id must surface so the
    // outbound runner persists it (workflow send output, edit chains).
    expect(result.platformMessageId).toBe("om_resp_001")
    // A successful send stamps lastActivityAt and, while still "starting",
    // is evidence enough to report running.
    expect(adapter.health().lastActivityAt).toBeDefined()
    expect(adapter.health().state).toBe("running")

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    expect(httpCalls.length).toBeGreaterThanOrEqual(2)

    const sendCall = httpCalls[1]
    const reqPayload = (sendCall[1] as { req: { url: string; headers: Record<string, string> } })
      .req
    expect(reqPayload.url).toContain("/im/v1/messages")
    expect(reqPayload.headers["Authorization"]).toContain("Bearer t-send-tat")
  })

  // ── send-as-user (opt-in user identity, ADR-0009 v41 / A4) ──
  // Returns the LAST send call so the refresh test sees the retried request.
  const findSend = () => {
    const sends = mockInvoke.mock.calls.filter(
      ([cmd, args]: [string, unknown]) =>
        cmd === "connectors_http_request" &&
        (args as { req: { url: string } }).req.url.includes("/im/v1/messages")
    )
    return sends[sends.length - 1]
  }

  const sendHeaders = (call: unknown[] | undefined) =>
    (call![1] as { req: { headers: Record<string, string> } }).req.headers

  it("send() uses the user access token when sendAsUser is on and a user token is connected", async () => {
    const adapter = createLarkAdapter({
      id: "lark-asuser",
      displayName: "As-User Bot",
      appId: async () => "cli_asuser",
      appSecret: async () => "secret_asuser",
      verificationToken: async () => "token",
      selfBotOpenId: "ou_bot",
      sendAsUser: true,
      transport: "long-connection",
    })

    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") {
        return (args as { credential: string }).credential === "user_token" ? "u-access-tok" : null
      }
      if (cmd === "connectors_http_request") return makeSendOkResp()
      return undefined
    })

    const result = await adapter.send({
      conversationRef: { platform: "lark", adapterId: "lark-asuser", channelId: "oc_chat_u" },
      segments: [{ type: "text", text: "hi as me" }],
      metadata: { idempotencyKey: "ku" },
    })

    expect(result.ok).toBe(true)
    expect(sendHeaders(findSend())["Authorization"]).toBe("Bearer u-access-tok")
  })

  it("send() falls back to the bot token when sendAsUser is on but no user token is connected", async () => {
    const adapter = createLarkAdapter({
      id: "lark-nouser",
      displayName: "No-User Bot",
      appId: async () => "cli_nouser",
      appSecret: async () => "secret_nouser",
      verificationToken: async () => "token",
      selfBotOpenId: "ou_bot",
      sendAsUser: true,
      transport: "long-connection",
    })

    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") return null // no user token connected
      if (cmd === "connectors_http_request") {
        const req = (args as { req: { url: string } }).req
        return req.url.includes("tenant_access_token") ? makeTatOkResp("t-bot") : makeSendOkResp()
      }
      return undefined
    })

    const result = await adapter.send({
      conversationRef: { platform: "lark", adapterId: "lark-nouser", channelId: "oc_chat_b" },
      segments: [{ type: "text", text: "hi from bot" }],
      metadata: { idempotencyKey: "kb" },
    })

    expect(result.ok).toBe(true)
    expect(sendHeaders(findSend())["Authorization"]).toBe("Bearer t-bot")
  })

  it("refreshes the user token on invalidation and retries the send once", async () => {
    const adapter = createLarkAdapter({
      id: "lark-refresh",
      displayName: "Refresh Bot",
      appId: async () => "cli_refresh",
      appSecret: async () => "secret_refresh",
      verificationToken: async () => "token",
      selfBotOpenId: "ou_bot",
      sendAsUser: true,
      transport: "long-connection",
    })

    let sendAttempts = 0
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") {
        const cred = (args as { credential: string }).credential
        if (cred === "user_token") return "u-old"
        if (cred === "user_refresh_token") return "u-refresh-old"
        return null
      }
      if (cmd === "connectors_keyring_set") return undefined
      if (cmd === "connectors_http_request") {
        const req = (args as { req: { url: string; headers: Record<string, string> } }).req
        if (req.url.includes("tenant_access_token")) return makeTatOkResp("tat-r")
        if (req.url.includes("/oauth/token")) {
          // v2 token endpoint — flat OAuth 2.0 refresh response.
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              code: 0,
              access_token: "u-new",
              refresh_token: "u-refresh-new",
              expires_in: 7200,
              refresh_token_expires_in: 31_104_000,
              token_type: "Bearer",
            }),
          }
        }
        if (req.url.includes("/im/v1/messages")) {
          sendAttempts++
          if (req.headers["Authorization"] === "Bearer u-old") {
            return {
              status: 401,
              headers: {},
              body: JSON.stringify({ code: 99991677, msg: "invalid user access token" }),
            }
          }
          return makeSendOkResp()
        }
      }
      return undefined
    })

    const result = await adapter.send({
      conversationRef: { platform: "lark", adapterId: "lark-refresh", channelId: "oc_chat_r" },
      segments: [{ type: "text", text: "retry me" }],
      metadata: { idempotencyKey: "kr" },
    })

    expect(result.ok).toBe(true)
    expect(sendAttempts).toBe(2) // failed once (old token), succeeded on the refreshed token
    expect(sendHeaders(findSend())["Authorization"]).toBe("Bearer u-new")
  })

  it("setTyping is absent (typing is undeclared — absence means unsupported)", () => {
    const adapter = makeAdapter()
    expect(adapter.setTyping).toBeUndefined()
  })

  it("fetchHistory() calls /im/v1/messages and yields parsed messages", async () => {
    // Fixture uses the REAL history-item shape (verified live against the
    // Feishu API): flat `sender.{id,id_type}` (not nested `sender_id`),
    // `msg_type` (not `message_type`) and content under `body.content`.
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "connectors_http_request") return undefined
      const req = (args as { req: { url: string } }).req
      if (req.url.includes("/im/v1/messages")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  message_id: "om_hist_001",
                  chat_id: "oc_chat_001",
                  msg_type: "text",
                  body: { content: '{"text":"history from lark"}' },
                  create_time: "1714900000000",
                  deleted: false,
                  sender: { id: "ou_hist_001", id_type: "open_id", sender_type: "user" },
                },
                // Bot/app sender — history reports app_id, must still parse.
                {
                  message_id: "om_hist_002",
                  chat_id: "oc_chat_001",
                  msg_type: "text",
                  body: { content: '{"text":"from our own bot"}' },
                  create_time: "1714900001000",
                  deleted: false,
                  sender: { id: "cli_app_1", id_type: "app_id", sender_type: "app" },
                },
                // Recalled — no recoverable content, must be skipped.
                {
                  message_id: "om_hist_003",
                  chat_id: "oc_chat_001",
                  msg_type: "text",
                  body: { content: "This message was recalled" },
                  deleted: true,
                  sender: { id: "ou_hist_001", id_type: "open_id", sender_type: "user" },
                },
                // System notice (join/invite banner) — skipped.
                {
                  message_id: "om_hist_004",
                  chat_id: "oc_chat_001",
                  msg_type: "system",
                  body: { content: '{"template":"{from_user} invited {to_chatters}."}' },
                  deleted: false,
                  sender: { id: "", id_type: "", sender_type: "" },
                },
              ],
              has_more: false,
            },
          }),
        }
      }
      return makeTatOkResp("t-history")
    })

    const adapter = makeAdapter()
    const events: NormalizedInboundEvent[] = []
    for await (const evt of adapter.fetchHistory!("lark:lark-1:oc_chat_001", {
      after: "1714899900",
      before: "1714900100",
    })) {
      events.push(evt)
    }
    expect(events).toHaveLength(2)
    expect(events[0].messageId).toBe("om_hist_001")
    expect(events[0].plainText).toBe("history from lark")
    expect(events[0].sender.remoteUserId).toBe("ou_hist_001")
    expect(events[0].sender.kind).toBe("human")
    expect(events[1].messageId).toBe("om_hist_002")
    expect(events[1].plainText).toBe("from our own bot")
    expect(events[1].sender.remoteUserId).toBe("cli_app_1")
    expect(events[1].sender.kind).toBe("bot")

    const historyCall = mockInvoke.mock.calls.find(
      ([cmd, args]: [string, { req?: { url?: string } }]) =>
        cmd === "connectors_http_request" && args.req?.url?.includes("/im/v1/messages")
    )
    expect(historyCall).toBeDefined()
    const url = new URL((historyCall![1] as { req: { url: string } }).req.url)
    expect(url.searchParams.get("container_id_type")).toBe("chat")
    expect(url.searchParams.get("container_id")).toBe("oc_chat_001")
    expect(url.searchParams.get("page_size")).toBe("50")
    expect(url.searchParams.get("start_time")).toBe("1714899900")
    expect(url.searchParams.get("end_time")).toBe("1714900100")
  })

  it("refreshCredentials() resolves without error", async () => {
    const adapter = makeAdapter()
    await expect(adapter.refreshCredentials!()).resolves.toBeUndefined()
  })

  // ── forward / merge-forward / urgent / read-receipt / reaction removal ──
  function mockHttp(dataByUrl: (url: string) => unknown) {
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") return null
      if (cmd === "connectors_http_request") {
        const url = (args as { req: { url: string } }).req.url
        if (url.includes("tenant_access_token")) return makeTatOkResp("t-x")
        return { status: 200, headers: {}, body: JSON.stringify(dataByUrl(url)) }
      }
      return undefined
    })
  }
  const httpCallTo = (substr: string) =>
    mockInvoke.mock.calls.find(
      ([cmd, args]: [string, unknown]) =>
        cmd === "connectors_http_request" &&
        (args as { req: { url: string } }).req.url.includes(substr)
    )?.[1] as { req: { url: string; method: string; body?: string } } | undefined

  it("forwardMessage() POSTs to /forward and surfaces the new message id", async () => {
    mockHttp(() => ({ code: 0, data: { message_id: "om_fwd" } }))
    const res = await makeAdapter().forwardMessage!({ messageId: "om_1", target: "oc_dest" })
    expect(res.ok).toBe(true)
    expect(res.platformMessageId).toBe("om_fwd")
    const call = httpCallTo("/forward")
    expect(call?.req.method).toBe("POST")
    expect(call?.req.url).toContain("receive_id_type=chat_id")
    expect(JSON.parse(call!.req.body!).receive_id).toBe("oc_dest")
  })

  it("forwardMessage() merge-forwards multiple ids", async () => {
    mockHttp(() => ({ code: 0, data: { message_id: "om_merged" } }))
    const res = await makeAdapter().forwardMessage!({
      messageIds: ["om_1", "om_2"],
      target: "oc_dest",
    })
    expect(res.ok).toBe(true)
    const call = httpCallTo("merge_forward")
    expect(call?.req.method).toBe("POST")
    expect(JSON.parse(call!.req.body!).message_id_list).toEqual(["om_1", "om_2"])
  })

  it("addReaction() surfaces the reaction_id and removeReaction() DELETEs it", async () => {
    mockHttp((url) =>
      url.includes("/reactions") ? { code: 0, data: { reaction_id: "rx_9" } } : { code: 0 }
    )
    const adapter = makeAdapter()
    const ref = await adapter.addReaction!("om_1", "THUMBSUP")
    expect((ref as { reactionId?: string }).reactionId).toBe("rx_9")
    await adapter.removeReaction!("om_1", "rx_9")
    expect(httpCallTo("/reactions/rx_9")?.req.method).toBe("DELETE")
  })

  it("getReadReceipt() GETs read_users and parses readers", async () => {
    mockHttp(() => ({
      code: 0,
      data: { items: [{ user_id: "ou_a", timestamp: "1700000000" }], has_more: false },
    }))
    const rr = await makeAdapter().getReadReceipt!("om_1")
    expect(rr.readers).toEqual([{ userId: "ou_a", readAt: 1700000000 }])
    expect(rr.hasMore).toBe(false)
    expect(httpCallTo("read_users")?.req.method).toBe("GET")
  })

  it("sendUrgent() PATCHes urgent_app with the user_id_list", async () => {
    mockHttp(() => ({ code: 0, data: {} }))
    await makeAdapter().sendUrgent!("om_1", ["ou_a"], "app")
    const call = httpCallTo("urgent_app")
    expect(call?.req.method).toBe("PATCH")
    expect(JSON.parse(call!.req.body!).user_id_list).toEqual(["ou_a"])
  })

  it("forwardMessage() with neither messageId nor messageIds returns a validation error (no HTTP)", async () => {
    mockHttp(() => ({ code: 0 }))
    const res = await makeAdapter().forwardMessage!({ target: "oc_dest" })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
    expect(res.error?.retryable).toBe(false)
    // The degenerate POST /im/v1/messages//forward must never be issued.
    expect(httpCallTo("/forward")).toBeUndefined()
  })

  it("getReadReceipt() walks page_token until exhausted and merges readers", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") return null
      if (cmd !== "connectors_http_request") return undefined
      const url = (args as { req: { url: string } }).req.url
      if (url.includes("tenant_access_token")) return makeTatOkResp("t-rr")
      const page2 = url.includes("page_token=tok2")
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          data: page2
            ? { items: [{ user_id: "ou_b", timestamp: "1700000002" }], has_more: false }
            : {
                items: [{ user_id: "ou_a", timestamp: "1700000001" }],
                has_more: true,
                page_token: "tok2",
              },
        }),
      }
    })
    const rr = await makeAdapter().getReadReceipt!("om_1")
    expect(rr.readers).toEqual([
      { userId: "ou_a", readAt: 1700000001 },
      { userId: "ou_b", readAt: 1700000002 },
    ])
    expect(rr.hasMore).toBe(false)
    const pages = mockInvoke.mock.calls.filter(
      ([cmd, args]: [string, unknown]) =>
        cmd === "connectors_http_request" &&
        (args as { req: { url: string } }).req.url.includes("read_users")
    )
    expect(pages).toHaveLength(2)
  })

  it("getReadReceipt() reports hasMore=true when the 10-page cap cuts the walk short", async () => {
    let readPages = 0
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") return null
      if (cmd !== "connectors_http_request") return undefined
      const url = (args as { req: { url: string } }).req.url
      if (url.includes("tenant_access_token")) return makeTatOkResp("t-rr2")
      readPages++
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          data: {
            items: [{ user_id: `ou_${readPages}` }],
            has_more: true,
            page_token: `tok${readPages}`,
          },
        }),
      }
    })
    const rr = await makeAdapter().getReadReceipt!("om_1")
    expect(readPages).toBe(10)
    expect(rr.readers).toHaveLength(10)
    expect(rr.hasMore).toBe(true)
  })

  it("fetchHistory() normalises millisecond before/after values to epoch seconds", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") return null
      if (cmd !== "connectors_http_request") return undefined
      const url = (args as { req: { url: string } }).req.url
      if (url.includes("tenant_access_token")) return makeTatOkResp("t-hist-ms")
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ code: 0, data: { items: [], has_more: false } }),
      }
    })
    const events = []
    for await (const evt of makeAdapter().fetchHistory!("lark:lark-1:oc_chat_001", {
      after: "1714899900000",
      before: "1714900100123",
    })) {
      events.push(evt)
    }
    const historyCall = mockInvoke.mock.calls.find(
      ([cmd, args]: [string, { req?: { url?: string } }]) =>
        cmd === "connectors_http_request" && args.req?.url?.includes("/im/v1/messages")
    )
    const url = new URL((historyCall![1] as { req: { url: string } }).req.url)
    // ms-epoch inputs (> 10^12) are divided down; seconds pass verbatim.
    expect(url.searchParams.get("start_time")).toBe("1714899900")
    expect(url.searchParams.get("end_time")).toBe("1714900100")
  })

  it("fetchHistory() never yields messages from the parent chat or another topic", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") return null
      if (cmd !== "connectors_http_request") return undefined
      const url = (args as { req: { url: string } }).req.url
      if (url.includes("tenant_access_token")) return makeTatOkResp("t-topic-history")
      const item = (message_id: string, thread_id?: string) => ({
        message_id,
        chat_id: "oc_chat_001",
        chat_type: "group",
        msg_type: "text",
        body: { content: JSON.stringify({ text: message_id }) },
        create_time: "1714900000000",
        thread_id,
        deleted: false,
        sender: { id: "ou_hist_001", id_type: "open_id", sender_type: "user" },
      })
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          data: {
            items: [
              item("om-wanted", "omt-wanted"),
              item("om-other", "omt-other"),
              item("om-root"),
            ],
            has_more: false,
          },
        }),
      }
    })

    const events = []
    for await (const evt of makeAdapter().fetchHistory!("lark:lark-1:oc_chat_001:omt-wanted", {
      max: 50,
    })) {
      events.push(evt)
    }
    expect(events.map((event) => event.messageId)).toEqual(["om-wanted"])
  })

  it("fetchHistoryPage() uses the persisted target and preserves its timestamp page token", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") return null
      if (cmd !== "connectors_http_request") return undefined
      const url = (args as { req: { url: string } }).req.url
      if (url.includes("tenant_access_token")) return makeTatOkResp("t-page")
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ code: 0, data: { items: [], has_more: true, page_token: "p2" } }),
      }
    })
    const target = {
      address: {
        conversationKey: "opaque-topic-key",
        platform: "lark" as const,
        adapterId: "lark-1",
        scopeKind: "thread" as const,
        containerId: "oc_target",
        topicId: "omt_target",
      },
      conversationRef: { platform: "lark" as const, adapterId: "lark-1" },
      refreshedAt: 1,
    }
    const page = await makeAdapter().fetchHistoryPage!(
      target,
      { kind: "timestamp", afterTimestamp: 1714900000000, pageToken: "p1" },
      { max: 50 }
    )
    const historyCall = mockInvoke.mock.calls.find(
      ([cmd, args]: [string, { req?: { url?: string } }]) =>
        cmd === "connectors_http_request" && args.req?.url?.includes("/im/v1/messages")
    )
    const url = new URL((historyCall![1] as { req: { url: string } }).req.url)
    expect(url.searchParams.get("container_id")).toBe("oc_target")
    expect(url.searchParams.get("start_time")).toBe("1714900000")
    expect(url.searchParams.get("page_token")).toBe("p1")
    expect(page.nextCursor).toEqual({
      kind: "timestamp",
      afterTimestamp: 1714900000000,
      beforeTimestamp: undefined,
      pageToken: "p2",
    })
    await expect(
      makeAdapter().fetchHistoryPage!(
        target,
        { kind: "message_id", beforeMessageId: "om_1" },
        {
          max: 50,
        }
      )
    ).rejects.toThrow(/message ids are not timestamps/)
  })

  // ── outbound error classification (retryability contract) ──
  const send400 = (body: Record<string, unknown>, status = 400) => {
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") return null
      if (cmd !== "connectors_http_request") return undefined
      const url = (args as { req: { url: string } }).req.url
      if (url.includes("tenant_access_token")) return makeTatOkResp("t-err")
      return { status, headers: {}, body: JSON.stringify(body) }
    })
  }
  const sendReq = {
    conversationRef: { platform: "lark" as const, adapterId: "lark-1", channelId: "oc_chat_e" },
    segments: [{ type: "text" as const, text: "x" }],
    metadata: { idempotencyKey: "ke" },
  }

  it("send() maps a 4xx business error (invalid receive_id) to non-retryable platform_4xx", async () => {
    send400({ code: 230002, msg: "invalid receive_id" })
    const res = await makeAdapter().send(sendReq)
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("platform_4xx")
    expect(res.error?.retryable).toBe(false)
    // The Lark code must be diagnosable from the message.
    expect(res.error?.message).toContain("230002")
  })

  it("send() maps permission code 99991672 to non-retryable auth_failed", async () => {
    send400({ code: 99991672, msg: "permission denied" }, 403)
    const res = await makeAdapter().send(sendReq)
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("auth_failed")
    expect(res.error?.retryable).toBe(false)
  })

  it("send() maps HTTP 429 to retryable rate_limited", async () => {
    send400({ code: 99991400, msg: "frequency limit" }, 429)
    const res = await makeAdapter().send(sendReq)
    expect(res.error?.code).toBe("rate_limited")
    expect(res.error?.retryable).toBe(true)
  })

  it("send() keeps 5xx retryable as platform_5xx", async () => {
    send400({ msg: "internal error" }, 502)
    const res = await makeAdapter().send(sendReq)
    expect(res.error?.code).toBe("platform_5xx")
    expect(res.error?.retryable).toBe(true)
  })

  it("send() maps transport-level failures (Rust bridge throw) to retryable network", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return null
      if (cmd === "connectors_http_request") throw new Error("connection reset")
      return undefined
    })
    const res = await makeAdapter().send(sendReq)
    expect(res.error?.code).toBe("network")
    expect(res.error?.retryable).toBe(true)
  })

  it("edit() classifies 4xx as non-retryable too", async () => {
    send400({ code: 230099, msg: "card schema reject" })
    const res = await makeAdapter().edit!("om_e1", sendReq)
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("platform_4xx")
    expect(res.error?.retryable).toBe(false)
  })

  it("send() refreshes the TAT once when a 400 body carries code 99991663", async () => {
    // The Lark code rides inside the 400 body — before the fix sendHttp threw
    // LarkApiError{code:null}, isLarkTatInvalidation missed it, and the main
    // send path never refreshed the token.
    let tatFetches = 0
    let sendAttempts = 0
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") return null
      if (cmd !== "connectors_http_request") return undefined
      const url = (args as { req: { url: string } }).req.url
      if (url.includes("tenant_access_token")) {
        tatFetches++
        return makeTatOkResp(`t-refresh-${tatFetches}`)
      }
      sendAttempts++
      if (sendAttempts === 1) {
        return {
          status: 400,
          headers: {},
          body: JSON.stringify({ code: 99991663, msg: "invalid access_token" }),
        }
      }
      return makeSendOkResp()
    })
    // Unique creds so the module-level TAT cache is cold for this test.
    const adapter = createLarkAdapter({
      id: "lark-tat-400",
      displayName: "TAT 400 Bot",
      appId: async () => "cli_tat_400",
      appSecret: async () => "secret_tat_400",
      verificationToken: async () => "token",
      selfBotOpenId: "ou_bot",
      transport: "long-connection",
    })
    const res = await adapter.send(sendReq)
    expect(res.ok).toBe(true)
    expect(sendAttempts).toBe(2) // failed once, retried once after refresh
    expect(tatFetches).toBe(2) // initial token + refreshed token
  })
})
