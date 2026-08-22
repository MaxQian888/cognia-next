/**
 * Adapter registry round-trip tests — Task 68 + Task 80 + Task 93.
 *
 * Verifies that buildAdapterFromRow correctly routes to each platform's builder
 * and that unsupported types return null.
 */

import { invoke } from "@tauri-apps/api/core"

const mockInvoke = invoke as jest.Mock

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))

jest.mock("./adapters/telegram", () => ({
  createTelegramAdapter: jest.fn().mockReturnValue({ platform: "telegram", id: "tg-mock" }),
}))

jest.mock("./adapters/discord", () => ({
  createDiscordAdapter: jest.fn().mockReturnValue({ platform: "discord", id: "dc-mock" }),
}))

jest.mock("./adapters/slack", () => ({
  createSlackAdapter: jest.fn().mockReturnValue({ platform: "slack", id: "sl-mock" }),
}))

jest.mock("./adapters/lark", () => ({
  createLarkAdapter: jest.fn().mockReturnValue({ platform: "lark", id: "lk-mock" }),
}))

jest.mock("./adapters/onebot", () => ({
  createOneBotAdapter: jest.fn().mockReturnValue({ platform: "onebot", id: "ob-mock" }),
}))

jest.mock("./adapters/matrix", () => ({
  createMatrixAdapter: jest.fn().mockReturnValue({ platform: "matrix", id: "mx-mock" }),
}))

jest.mock("./adapters/dingtalk", () => ({
  createDingTalkAdapter: jest.fn().mockReturnValue({ platform: "dingtalk", id: "dt-mock" }),
}))

jest.mock("./adapters/qq-official", () => ({
  createQQOfficialAdapter: jest.fn().mockReturnValue({ platform: "qq-official", id: "qq-mock" }),
}))

jest.mock("./adapters/dingtalk/auth", () => ({
  getDingTalkAccessToken: jest.fn().mockResolvedValue("dt-token"),
}))

jest.mock("./adapters/qq-official/auth", () => ({
  getQQAccessToken: jest.fn().mockResolvedValue("qq-token"),
  clearQQTokenCache: jest.fn(),
}))

import {
  buildAdapterFromRow,
  buildDiscordAdapter,
  buildSlackAdapter,
  buildLarkAdapter,
  buildOneBotAdapter,
  buildMatrixAdapter,
  buildDingTalkAdapter,
  buildQQOfficialAdapter,
} from "./adapter-registry"
import { createTelegramAdapter } from "./adapters/telegram"
import { createDiscordAdapter } from "./adapters/discord"
import { createSlackAdapter } from "./adapters/slack"
import { createLarkAdapter } from "./adapters/lark"
import { createOneBotAdapter } from "./adapters/onebot"
import { createMatrixAdapter } from "./adapters/matrix"
import { createDingTalkAdapter } from "./adapters/dingtalk"
import { createQQOfficialAdapter } from "./adapters/qq-official"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

const mockCreateTelegramAdapter = createTelegramAdapter as jest.Mock
const mockCreateDiscordAdapter = createDiscordAdapter as jest.Mock
const mockCreateSlackAdapter = createSlackAdapter as jest.Mock
const mockCreateLarkAdapter = createLarkAdapter as jest.Mock
const mockCreateOneBotAdapter = createOneBotAdapter as jest.Mock
const mockCreateMatrixAdapter = createMatrixAdapter as jest.Mock
const mockCreateDingTalkAdapter = createDingTalkAdapter as jest.Mock
const mockCreateQQOfficialAdapter = createQQOfficialAdapter as jest.Mock

function makeRow(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "test-adapter",
    type: "telegram",
    displayName: "Test Adapter",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
    trigger: defaultPrivateChatPolicy(),
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

function makeKeyringOkResp() {
  return "FAKE-TOKEN"
}

function makeGetMeResp(id: number) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, result: { id } }),
  }
}

function makeDiscordMeResp(id: string) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ id, username: "testbot" }),
  }
}

function makeSlackAuthTestResp(userId: string) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, user: "testbot", user_id: userId, team: "Test Workspace" }),
  }
}

function makeLarkBotInfoResp(openId: string) {
  // Lark `/open-apis/bot/v3/info` returns `{ code, msg, bot: { open_id, ... } }`
  // (see `lib/connectors/adapters/lark/whoami.ts:LarkBotInfoResponse`). The
  // earlier `data.open_id` shape here mirrored a buggy parser in
  // `refreshSelfBotOpenId` that always reported `api-failed` against real
  // Lark traffic — fixed in lockstep.
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, bot: { open_id: openId, app_name: "cognia-bot" } }),
  }
}

function makeLarkTatResp() {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, tenant_access_token: "t-test-tat", expire: 7200 }),
  }
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockCreateTelegramAdapter.mockClear()
  mockCreateDiscordAdapter.mockClear()
  mockCreateSlackAdapter.mockClear()
  mockCreateLarkAdapter.mockClear()
  mockCreateOneBotAdapter.mockClear()
  mockCreateMatrixAdapter.mockClear()
  mockCreateDingTalkAdapter.mockClear()
  mockCreateQQOfficialAdapter.mockClear()
})

describe("buildQQOfficialAdapter", () => {
  it("uses transportMode as the sole transport source", async () => {
    const row = makeRow({
      id: "qq-transport",
      type: "qq-official",
      transportMode: "gateway",
      settings: { transport: "webhook" },
    })

    await buildQQOfficialAdapter(row)

    expect(mockCreateQQOfficialAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ id: row.id, transportMode: "gateway" })
    )
  })

  it("injects clearTokenCache that evicts THIS row's appId/clientSecret mint", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args: { credential?: string }) => {
      if (cmd === "connectors_keyring_get") {
        return args.credential === "appId"
          ? "APP"
          : args.credential === "clientSecret"
            ? "SECRET"
            : null
      }
      return null
    })
    const row = makeRow({ id: "qq-clear", type: "qq-official" })
    await buildQQOfficialAdapter(row)
    const opts = mockCreateQQOfficialAdapter.mock.calls.at(-1)![0] as {
      accessToken: () => Promise<string>
      clearTokenCache?: () => Promise<void>
    }
    expect(typeof opts.clearTokenCache).toBe("function")
    await opts.clearTokenCache!()
    const { clearQQTokenCache, getQQAccessToken } = jest.requireMock(
      "./adapters/qq-official/auth"
    ) as { clearQQTokenCache: jest.Mock; getQQAccessToken: jest.Mock }
    expect(clearQQTokenCache).toHaveBeenCalledWith("APP", "SECRET")
    await expect(opts.accessToken()).resolves.toBe("qq-token")
    expect(getQQAccessToken).toHaveBeenCalledWith("APP", "SECRET")
  })
})

describe("buildMatrixAdapter", () => {
  it("passes detailed whoami user and device identity into the E2EE adapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "matrix-token"
      if (cmd === "connectors_http_request") {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ user_id: "@bot:matrix.org", device_id: "DEVICE" }),
        }
      }
      return null
    })
    const row = makeRow({
      id: "mx-identity",
      type: "matrix",
      settings: { homeserver: "https://matrix.org" },
    })

    await buildMatrixAdapter(row)

    expect(mockCreateMatrixAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        id: row.id,
        homeserver: "https://matrix.org",
        selfId: "@bot:matrix.org",
        deviceId: "DEVICE",
      })
    )
  })

  it("preserves a missing device id so startup can fail closed", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "matrix-token"
      if (cmd === "connectors_http_request") {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ user_id: "@bot:matrix.org" }),
        }
      }
      return null
    })

    await buildMatrixAdapter(
      makeRow({ type: "matrix", settings: { homeserver: "https://matrix.org" } })
    )

    expect(mockCreateMatrixAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ selfId: "@bot:matrix.org", deviceId: "" })
    )
  })
})

// ---------------------------------------------------------------------------
// buildAdapterFromRow — switch routing
// ---------------------------------------------------------------------------

describe("buildAdapterFromRow", () => {
  it("routes 'telegram' type to buildTelegramAdapter and returns an adapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return makeKeyringOkResp()
      if (cmd === "connectors_http_request") return makeGetMeResp(77777)
      return null
    })

    const row = makeRow({ id: "tg-1", type: "telegram" })
    const adapter = await buildAdapterFromRow(row)
    expect(adapter).not.toBeNull()
    expect(mockCreateTelegramAdapter).toHaveBeenCalledTimes(1)
    expect(mockCreateDiscordAdapter).not.toHaveBeenCalled()
  })

  it("routes 'discord' type to buildDiscordAdapter and returns an adapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return makeKeyringOkResp()
      if (cmd === "connectors_http_request") return makeDiscordMeResp("99999")
      return null
    })

    const row = makeRow({ id: "dc-1", type: "discord", transportMode: "gateway" })
    const adapter = await buildAdapterFromRow(row)
    expect(adapter).not.toBeNull()
    expect(mockCreateDiscordAdapter).toHaveBeenCalledTimes(1)
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
  })

  it("routes 'slack' type to buildSlackAdapter and returns an adapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return makeKeyringOkResp()
      if (cmd === "connectors_http_request") return makeSlackAuthTestResp("USLACK1")
      return null
    })

    const row = makeRow({ id: "sl-1", type: "slack", transportMode: "gateway" })
    const adapter = await buildAdapterFromRow(row)
    expect(adapter).not.toBeNull()
    expect(mockCreateSlackAdapter).toHaveBeenCalledTimes(1)
    expect(mockCreateDiscordAdapter).not.toHaveBeenCalled()
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
  })

  it("routes 'lark' type to buildLarkAdapter and returns an adapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return makeKeyringOkResp()
      if (cmd === "connectors_http_request") return makeLarkBotInfoResp("ou_lark_bot_001")
      return null
    })

    const row = makeRow({ id: "lk-1", type: "lark", transportMode: "gateway" })
    const adapter = await buildAdapterFromRow(row)
    expect(adapter).not.toBeNull()
    expect(mockCreateLarkAdapter).toHaveBeenCalledTimes(1)
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
    expect(mockCreateDiscordAdapter).not.toHaveBeenCalled()
    expect(mockCreateSlackAdapter).not.toHaveBeenCalled()
  })

  it("routes 'onebot' type to buildOneBotAdapter and returns an adapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return null // no bearer configured
      return null
    })

    const row = makeRow({
      id: "ob-1",
      type: "onebot",
      transportMode: "reverse-ws",
      settings: { selfBotUin: "123456789" },
    })
    const adapter = await buildAdapterFromRow(row)
    expect(adapter).not.toBeNull()
    expect(mockCreateOneBotAdapter).toHaveBeenCalledTimes(1)
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
  })

  it("routes 'dingtalk' type to buildDingTalkAdapter and returns an adapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "FAKE-CRED"
      return null
    })
    const row = makeRow({
      id: "dt-1",
      type: "dingtalk",
      transportMode: "longpoll",
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["appKey", "appSecret"] },
    })
    const adapter = await buildAdapterFromRow(row)
    expect(adapter).not.toBeNull()
    expect(mockCreateDingTalkAdapter).toHaveBeenCalledTimes(1)
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
  })

  it("buildDingTalkAdapter wires lazy resolvers that read credentials from the keyring", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "cred"
      return null
    })
    await buildDingTalkAdapter(makeRow({ id: "dt-2", type: "dingtalk" }))
    const opts = mockCreateDingTalkAdapter.mock.calls[0][0]
    expect(opts.id).toBe("dt-2")
    expect(opts.displayName).toBe("Test Adapter")
    expect(await opts.appKey()).toBe("cred")
    expect(await opts.appSecret()).toBe("cred")
    expect(await opts.accessToken()).toBe("dt-token")
  })

  it("returns null and warns for an unsupported type", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const row = makeRow({ type: "unknown-platform" as never })
    const adapter = await buildAdapterFromRow(row)
    expect(adapter).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown-platform"))
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// buildDiscordAdapter — selfId resolution
// ---------------------------------------------------------------------------

describe("buildDiscordAdapter", () => {
  it("passes selfId resolved from /users/@me into createDiscordAdapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "BOT-TOKEN"
      if (cmd === "connectors_http_request") return makeDiscordMeResp("42424242")
      return null
    })

    const row = makeRow({ id: "dc-2", type: "discord", transportMode: "gateway" })
    await buildDiscordAdapter(row)

    const callArgs = mockCreateDiscordAdapter.mock.calls[0][0] as {
      id: string
      selfId: string
      botToken: () => Promise<string>
    }
    expect(callArgs.id).toBe("dc-2")
    expect(callArgs.selfId).toBe("42424242")
    expect(typeof callArgs.botToken).toBe("function")
  })

  it("forwards a numeric settings.intents into createDiscordAdapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "T"
      if (cmd === "connectors_http_request") return makeDiscordMeResp("1")
      return null
    })

    const row = makeRow({
      id: "dc-intents",
      type: "discord",
      transportMode: "gateway",
      settings: { intents: 4096 },
    })
    await buildDiscordAdapter(row)

    const callArgs = mockCreateDiscordAdapter.mock.calls[0][0] as { intents?: number }
    expect(callArgs.intents).toBe(4096)
  })

  it("omits intents when settings has none (adapter uses the default)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "T"
      if (cmd === "connectors_http_request") return makeDiscordMeResp("1")
      return null
    })

    const row = makeRow({ id: "dc-no-intents", type: "discord", transportMode: "gateway" })
    await buildDiscordAdapter(row)

    const callArgs = mockCreateDiscordAdapter.mock.calls[0][0] as { intents?: number }
    expect(callArgs.intents).toBeUndefined()
  })

  it("forwards the row transportMode into createDiscordAdapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "T"
      if (cmd === "connectors_http_request") return makeDiscordMeResp("1")
      return null
    })

    const row = makeRow({ id: "dc-wh", type: "discord", transportMode: "webhook" })
    await buildDiscordAdapter(row)

    const callArgs = mockCreateDiscordAdapter.mock.calls[0][0] as { transportMode?: string }
    expect(callArgs.transportMode).toBe("webhook")
  })

  it("falls back to empty selfId when /users/@me throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "BAD-TOKEN"
      if (cmd === "connectors_http_request") throw new Error("network error")
      return null
    })

    const row = makeRow({ id: "dc-3", type: "discord", transportMode: "gateway" })
    await buildDiscordAdapter(row)

    const callArgs = mockCreateDiscordAdapter.mock.calls[0][0] as { selfId: string }
    expect(callArgs.selfId).toBe("")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dc-3"))
    warnSpy.mockRestore()
  })

  it("botToken factory resolves fresh token from keyring on each call", async () => {
    let callCount = 0
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") {
        callCount++
        return `TOKEN-${callCount}`
      }
      if (cmd === "connectors_http_request") return makeDiscordMeResp("111")
      return null
    })

    const row = makeRow({ id: "dc-4", type: "discord", transportMode: "gateway" })
    await buildDiscordAdapter(row)

    const callArgs = mockCreateDiscordAdapter.mock.calls[0][0] as {
      botToken: () => Promise<string>
    }
    // Invoking botToken() triggers a fresh keyring lookup
    const token = await callArgs.botToken()
    expect(token).toMatch(/^TOKEN-/)
  })
})

// ---------------------------------------------------------------------------
// buildSlackAdapter — selfId resolution
// ---------------------------------------------------------------------------

describe("buildSlackAdapter", () => {
  it("passes selfId resolved from auth.test into createSlackAdapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "xoxb-BOT-TOKEN"
      if (cmd === "connectors_http_request") return makeSlackAuthTestResp("USLACK99")
      return null
    })

    const row = makeRow({ id: "sl-2", type: "slack", transportMode: "gateway" })
    await buildSlackAdapter(row)

    const callArgs = mockCreateSlackAdapter.mock.calls[0][0] as {
      id: string
      selfId: string
      transport: string
      botToken: () => Promise<string>
    }
    expect(callArgs.id).toBe("sl-2")
    expect(callArgs.selfId).toBe("USLACK99")
    expect(callArgs.transport).toBe("socket-mode")
    expect(typeof callArgs.botToken).toBe("function")
  })

  it("falls back to empty selfId when auth.test throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "xoxb-BAD"
      if (cmd === "connectors_http_request") throw new Error("network error")
      return null
    })

    const row = makeRow({ id: "sl-3", type: "slack", transportMode: "gateway" })
    await buildSlackAdapter(row)

    const callArgs = mockCreateSlackAdapter.mock.calls[0][0] as { selfId: string }
    expect(callArgs.selfId).toBe("")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("sl-3"))
    warnSpy.mockRestore()
  })

  it("uses events-api-webhook transport when settings.transport is events-api-webhook", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "xoxb-TOKEN"
      if (cmd === "connectors_http_request") return makeSlackAuthTestResp("U111")
      return null
    })

    const row = makeRow({
      id: "sl-4",
      type: "slack",
      transportMode: "webhook",
      settings: { transport: "events-api-webhook" },
    })
    await buildSlackAdapter(row)

    const callArgs = mockCreateSlackAdapter.mock.calls[0][0] as { transport: string }
    expect(callArgs.transport).toBe("events-api-webhook")
  })

  it("passes assistantAppEnabled + validated historyMaxPages from row.settings", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "xoxb-TOKEN"
      if (cmd === "connectors_http_request") return makeSlackAuthTestResp("U111")
      return null
    })

    const row = makeRow({
      id: "sl-5",
      type: "slack",
      transportMode: "gateway",
      settings: { assistantAppEnabled: true, historyMaxPages: "25" },
    })
    await buildSlackAdapter(row)

    const callArgs = mockCreateSlackAdapter.mock.calls[0][0] as {
      assistantAppEnabled: boolean
      historyMaxPages?: number
    }
    expect(callArgs.assistantAppEnabled).toBe(true)
    // Numeric string is validated + floored into a number.
    expect(callArgs.historyMaxPages).toBe(25)
  })

  it("defaults assistantAppEnabled to false and drops invalid historyMaxPages", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "xoxb-TOKEN"
      if (cmd === "connectors_http_request") return makeSlackAuthTestResp("U111")
      return null
    })

    const row = makeRow({
      id: "sl-6",
      type: "slack",
      transportMode: "gateway",
      settings: { assistantAppEnabled: "yes", historyMaxPages: -3 },
    })
    await buildSlackAdapter(row)

    const callArgs = mockCreateSlackAdapter.mock.calls[0][0] as {
      assistantAppEnabled: boolean
      historyMaxPages?: number
    }
    expect(callArgs.assistantAppEnabled).toBe(false)
    expect(callArgs.historyMaxPages).toBeUndefined()
  })

  it("userToken resolver prefers 'userToken' and falls back to legacy 'user_token'", async () => {
    const keyring = new Map<string, string>([["user_token", "xoxp-legacy"]])
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "connectors_keyring_get") {
        const credential = (args as { credential?: string })?.credential ?? ""
        return keyring.get(credential) ?? (credential === "botToken" ? "xoxb-TOKEN" : null)
      }
      if (cmd === "connectors_http_request") return makeSlackAuthTestResp("U111")
      return null
    })

    const row = makeRow({ id: "sl-7", type: "slack", transportMode: "gateway" })
    await buildSlackAdapter(row)

    const callArgs = mockCreateSlackAdapter.mock.calls[0][0] as {
      userToken: () => Promise<string>
    }
    // Only the legacy key exists → fallback kicks in.
    await expect(callArgs.userToken()).resolves.toBe("xoxp-legacy")

    // Canonical key wins once present.
    keyring.set("userToken", "xoxp-new")
    await expect(callArgs.userToken()).resolves.toBe("xoxp-new")
  })
})

// ---------------------------------------------------------------------------
// buildLarkAdapter — selfBotOpenId resolution
// ---------------------------------------------------------------------------

describe("buildLarkAdapter", () => {
  it("passes selfBotOpenId resolved from bot/v3/info into createLarkAdapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "connectors_keyring_get") return "lark-cred-value"
      if (cmd === "connectors_http_request") {
        const url = (args as { req?: { url?: string } })?.req?.url ?? ""
        if (url.includes("tenant_access_token")) return makeLarkTatResp()
        return makeLarkBotInfoResp("ou_bot_open_001")
      }
      return null
    })

    const row = makeRow({
      id: "lk-10",
      type: "lark",
      transportMode: "gateway",
      settings: { transport: "long-connection" },
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["appId", "appSecret", "encryptKey", "verificationToken"],
      },
    })
    await buildLarkAdapter(row)

    const callArgs = mockCreateLarkAdapter.mock.calls[0][0] as {
      id: string
      selfBotOpenId: string
      transport: string
      appId: () => Promise<string>
    }
    expect(callArgs.id).toBe("lk-10")
    expect(callArgs.selfBotOpenId).toBe("ou_bot_open_001")
    expect(callArgs.transport).toBe("long-connection")
    expect(typeof callArgs.appId).toBe("function")
  })

  it("falls back to empty selfBotOpenId when bot/v3/info throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "connectors_keyring_get") return "lark-cred"
      if (cmd === "connectors_http_request") {
        const url = (args as { req?: { url?: string } })?.req?.url ?? ""
        if (url.includes("tenant_access_token")) return makeLarkTatResp()
        throw new Error("network error")
      }
      return null
    })

    const row = makeRow({ id: "lk-11", type: "lark", transportMode: "gateway" })
    await buildLarkAdapter(row)

    const callArgs = mockCreateLarkAdapter.mock.calls[0][0] as { selfBotOpenId: string }
    expect(callArgs.selfBotOpenId).toBe("")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("lk-11"))
    warnSpy.mockRestore()
  })

  it("uses webhook transport when settings.transport is webhook", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "connectors_keyring_get") return "lark-cred"
      if (cmd === "connectors_http_request") {
        const url = (args as { req?: { url?: string } })?.req?.url ?? ""
        if (url.includes("tenant_access_token")) return makeLarkTatResp()
        return makeLarkBotInfoResp("ou_wh_bot")
      }
      return null
    })

    const row = makeRow({
      id: "lk-12",
      type: "lark",
      transportMode: "webhook",
      settings: { transport: "webhook" },
    })
    await buildLarkAdapter(row)

    const callArgs = mockCreateLarkAdapter.mock.calls[0][0] as { transport: string }
    expect(callArgs.transport).toBe("webhook")
  })

  it("credential factories resolve fresh values from keyring on each call", async () => {
    let callCount = 0
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "connectors_keyring_get") {
        callCount++
        return `CRED-${callCount}`
      }
      if (cmd === "connectors_http_request") {
        const url = (args as { req?: { url?: string } })?.req?.url ?? ""
        if (url.includes("tenant_access_token")) return makeLarkTatResp()
        return makeLarkBotInfoResp("ou_fresh")
      }
      return null
    })

    const row = makeRow({ id: "lk-13", type: "lark", transportMode: "gateway" })
    await buildLarkAdapter(row)

    const callArgs = mockCreateLarkAdapter.mock.calls[0][0] as {
      appId: () => Promise<string>
    }
    const cred = await callArgs.appId()
    expect(cred).toMatch(/^CRED-/)
  })
})

// ---------------------------------------------------------------------------
// buildOneBotAdapter — no API call required
// ---------------------------------------------------------------------------

describe("buildOneBotAdapter", () => {
  it("passes selfBotUin from settings into createOneBotAdapter", async () => {
    mockInvoke.mockResolvedValue(null)

    const row = makeRow({
      id: "ob-10",
      type: "onebot",
      transportMode: "reverse-ws",
      settings: { selfBotUin: "987654321", expectedClient: "napcat" },
    })
    await buildOneBotAdapter(row)

    const callArgs = mockCreateOneBotAdapter.mock.calls[0][0] as {
      id: string
      selfBotUin: string
      expectedClient: string
      bearerToken: () => Promise<string>
    }
    expect(callArgs.id).toBe("ob-10")
    expect(callArgs.selfBotUin).toBe("987654321")
    expect(callArgs.expectedClient).toBe("napcat")
    expect(typeof callArgs.bearerToken).toBe("function")
  })

  it("bearerToken factory resolves from keyring on each call", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_keyring_get") return "secret-bearer"
      return null
    })

    const row = makeRow({
      id: "ob-11",
      type: "onebot",
      transportMode: "reverse-ws",
      settings: { selfBotUin: "111" },
    })
    await buildOneBotAdapter(row)

    const callArgs = mockCreateOneBotAdapter.mock.calls[0][0] as {
      bearerToken: () => Promise<string>
    }
    const token = await callArgs.bearerToken()
    expect(token).toBe("secret-bearer")
  })

  it("selfBotUin falls back to empty string when settings is missing", async () => {
    mockInvoke.mockResolvedValue(null)

    const row = makeRow({ id: "ob-12", type: "onebot", transportMode: "reverse-ws", settings: {} })
    await buildOneBotAdapter(row)

    const callArgs = mockCreateOneBotAdapter.mock.calls[0][0] as { selfBotUin: string }
    expect(callArgs.selfBotUin).toBe("")
  })
})
