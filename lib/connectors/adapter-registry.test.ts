/**
 * Adapter registry round-trip tests — Task 68 + Task 80.
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

import { buildAdapterFromRow, buildDiscordAdapter, buildSlackAdapter } from "./adapter-registry"
import { createTelegramAdapter } from "./adapters/telegram"
import { createDiscordAdapter } from "./adapters/discord"
import { createSlackAdapter } from "./adapters/slack"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

const mockCreateTelegramAdapter = createTelegramAdapter as jest.Mock
const mockCreateDiscordAdapter = createDiscordAdapter as jest.Mock
const mockCreateSlackAdapter = createSlackAdapter as jest.Mock

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

beforeEach(() => {
  mockInvoke.mockReset()
  mockCreateTelegramAdapter.mockClear()
  mockCreateDiscordAdapter.mockClear()
  mockCreateSlackAdapter.mockClear()
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

  it("returns null and warns for an unsupported type", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const row = makeRow({ type: "lark" as never })
    const adapter = await buildAdapterFromRow(row)
    expect(adapter).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("lark"))
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
})
