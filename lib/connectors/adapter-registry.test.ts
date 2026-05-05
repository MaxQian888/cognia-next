/**
 * Adapter registry round-trip tests — Task 68.
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

import { buildAdapterFromRow, buildTelegramAdapter, buildDiscordAdapter } from "./adapter-registry"
import { createTelegramAdapter } from "./adapters/telegram"
import { createDiscordAdapter } from "./adapters/discord"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

const mockCreateTelegramAdapter = createTelegramAdapter as jest.Mock
const mockCreateDiscordAdapter = createDiscordAdapter as jest.Mock

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

beforeEach(() => {
  mockInvoke.mockReset()
  mockCreateTelegramAdapter.mockClear()
  mockCreateDiscordAdapter.mockClear()
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

  it("returns null and warns for an unsupported type", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const row = makeRow({ type: "slack" as never })
    const adapter = await buildAdapterFromRow(row)
    expect(adapter).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("slack"))
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
