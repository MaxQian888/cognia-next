/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import {
  CHAT_TAB_URL_VERSION,
  buildAuthorizedConversationLink,
  buildSurfaceUrl,
  buildRunDetailsUrl,
  resolveWebEntryBase,
  buildWorkbenchUrl,
  readWorkbenchMode,
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

describe("workbench entry configuration", () => {
  it.each(["personal", "team", "both"] as const)("accepts configured %s mode", (mode) => {
    expect(readWorkbenchMode({ settings: { larkWorkbenchMode: mode } })).toBe(mode)
  })
  it.each([undefined, null, "", "invalid", true])("does not enable an invalid mode %s", (mode) => {
    expect(readWorkbenchMode({ settings: { larkWorkbenchMode: mode } })).toBe("disabled")
  })
  it("builds a stable entry without a user credential or expiring token", () => {
    expect(buildWorkbenchUrl("lk/1", "https://cognia.example/app/")).toBe(
      "https://cognia.example/app/lark/workbench?adapter_id=lk%2F1"
    )
  })
  it.each([null, "", "javascript:alert(1)", "https://x.test/?token=x", "https://u:p@x.test"])(
    "refuses unsafe base %s",
    (base) => expect(buildWorkbenchUrl("lk", base)).toBeNull()
  )
  it("requires an adapter", () => expect(buildWorkbenchUrl("", "https://x.test")).toBeNull())
})

describe("external run details URLs", () => {
  it("preserves a deployment prefix and encodes the exact run identifier", () => {
    expect(buildRunDetailsUrl("execution:agent:session:turn", "https://cognia.example/app/")).toBe(
      "https://cognia.example/app/agent-runs?run=execution%3Aagent%3Asession%3Aturn"
    )
  })
  it.each([
    null,
    "",
    "/agent-runs",
    "javascript:alert(1)",
    "https://user:pass@example.com",
    "https://example.com?token=secret",
    "https://example.com/#token",
  ])("omits a missing or unsafe web base: %s", (base) => {
    expect(buildRunDetailsUrl("run-1", base)).toBeNull()
  })
})

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
    const ssoOff = {
      ...ENTRY_INPUT,
      adapterRow: { settings: { larkWebSso: false } },
    } as typeof ENTRY_INPUT
    expect(await buildAuthorizedConversationLink(ssoOff, { call })).toBeNull()
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
    const unflagged = { ...input, adapterRow: { settings: { larkChatTab: false } } }
    expect(await buildSurfaceUrl(unflagged, { call })).toBeNull()

    const flagged = { ...input, adapterRow: { settings: { larkChatTab: true } } }
    const url = await buildSurfaceUrl(flagged, { call })
    expect(url).toBe("https://cognia.example/lark/entry?surface=sfc.tok")
    const [, args] = (call as jest.Mock).mock.calls[0]
    expect(args).toMatchObject({ urlVersion: CHAT_TAB_URL_VERSION })
  })
})
