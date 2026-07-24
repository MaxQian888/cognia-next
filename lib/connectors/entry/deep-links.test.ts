/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import {
  CHAT_TAB_URL_VERSION,
  buildAuthorizedConversationLink,
  buildSurfaceUrl,
  resolveWebEntryBase,
} from "./deep-links"

const ENTRY_INPUT = {
  adapterId: "lk-1",
  principalId: "fp_1",
  accountId: "acct_a",
  openId: "ou_alice",
  tenantKey: "tk_a",
  appId: "cli_1",
  entryType: "bot_menu" as const,
  conversationKey: "lark:lk-1:oc_1",
}

const ENV_KEYS = ["COGNIA_LARK_WEB_BASE", "NEXT_PUBLIC_COGNIA_WEB_BASE"]

describe("authorized deep links", () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it("resolves the web base from settings, then env, and rejects non-http values", () => {
    expect(resolveWebEntryBase()).toBeNull()
    process.env.COGNIA_LARK_WEB_BASE = "https://cognia.example/"
    expect(resolveWebEntryBase()).toBe("https://cognia.example")
    expect(resolveWebEntryBase({ settings: { webEntryBaseUrl: "https://tenant.example//" } })).toBe(
      "https://tenant.example"
    )
    expect(resolveWebEntryBase({ settings: { webEntryBaseUrl: "not-a-url" } })).toBeNull()
  })

  it("returns null (never a raw key) when no base is configured", async () => {
    const call = jest.fn() as never
    expect(await buildAuthorizedConversationLink(ENTRY_INPUT, { call })).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it("returns null when web SSO is off — personal links need a session to resolve", async () => {
    process.env.COGNIA_LARK_WEB_BASE = "https://cognia.example"
    const call = jest.fn() as never
    expect(await buildAuthorizedConversationLink(ENTRY_INPUT, { call })).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it("wraps the minted entry token and never embeds the conversationKey", async () => {
    process.env.COGNIA_LARK_WEB_BASE = "https://cognia.example"
    const call = jest.fn(async () => ({
      token: "tok.abc",
      jti: "j1",
      expiresAt: 1,
    })) as never
    const url = await buildAuthorizedConversationLink(
      { ...ENTRY_INPUT, adapterRow: { settings: { larkWebSso: true } } },
      { call }
    )
    expect(url).toBe("https://cognia.example/lark/entry?entry=tok.abc")
    expect(url).not.toContain("oc_1")
  })

  it("falls back to the bare workbench URL when minting fails", async () => {
    process.env.COGNIA_LARK_WEB_BASE = "https://cognia.example"
    const call = jest.fn(async () => {
      throw new Error("companion down")
    }) as never
    expect(
      await buildAuthorizedConversationLink(
        { ...ENTRY_INPUT, adapterRow: { settings: { larkWebSso: true } } },
        { call }
      )
    ).toBe("https://cognia.example")
  })

  it("builds chat-tab surface URLs only when the flag is on", async () => {
    process.env.COGNIA_LARK_WEB_BASE = "https://cognia.example"
    const call = jest.fn(async () => ({ token: "sfc.tok" })) as never
    const input = {
      adapterId: "lk-1",
      tenantKey: "tk_a",
      appId: "cli_1",
      chatId: "oc_9",
      surface: "chat_tab" as const,
    }
    expect(await buildSurfaceUrl(input, { call })).toBeNull()

    const flagged = { ...input, adapterRow: { settings: { larkChatTab: true } } }
    const url = await buildSurfaceUrl(flagged, { call })
    expect(url).toBe("https://cognia.example/lark/entry?surface=sfc.tok")
    const [, args] = (call as jest.Mock).mock.calls[0]
    expect(args).toMatchObject({ urlVersion: CHAT_TAB_URL_VERSION })
  })
})
