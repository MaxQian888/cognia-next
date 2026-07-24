/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import {
  LARK_INTENT_TOPIC,
  handleLarkIntentFrame,
  installLarkIntentHandler,
  isChatMember,
  type LarkIntentDependencies,
} from "./consumed-handler"

function makeDeps(overrides: Partial<LarkIntentDependencies> = {}) {
  return {
    call: jest.fn(async (_name: string, _args?: Record<string, unknown>) => ({}) as never),
    keyringGet: jest.fn(async (_a: string, credential: string) =>
      credential === "appId" ? "cli_1" : "secret_1"
    ),
    tenantRequest: jest.fn(async () => ({ data: { items: [] } })),
    markConsumed: jest.fn(async () => undefined),
    audit: jest.fn(async (_e: unknown) => ({}) as never),
    ...overrides,
  } as LarkIntentDependencies & {
    call: jest.Mock
    keyringGet: jest.Mock
    tenantRequest: jest.Mock
    markConsumed: jest.Mock
    audit: jest.Mock
  }
}

describe("handleLarkIntentFrame", () => {
  it("marks the ledger + audits on entry_consumed", async () => {
    const deps = makeDeps()
    await handleLarkIntentFrame(
      { kind: "entry_consumed", jti: "jti_9", adapterId: "lk-1", entryType: "bot_menu" },
      deps
    )
    expect(deps.markConsumed).toHaveBeenCalledWith("jti_9")
    expect((deps.audit.mock.calls[0][0] as { kind: string }).kind).toBe("entry.consumed")
    expect(deps.call).not.toHaveBeenCalled()
  })

  it("answers resolve_surface with the conversationKey for members", async () => {
    const deps = makeDeps({
      tenantRequest: jest.fn(async () => ({
        data: { items: [{ member_id: "ou_alice" }], has_more: false },
      })) as never,
    })
    await handleLarkIntentFrame(
      {
        kind: "resolve_surface",
        requestId: "req_1",
        adapterId: "lk-1",
        chatId: "oc_9",
        surface: "chat_tab",
        verifiedIdentity: { openId: "ou_alice", tenantKey: "tk_a", appId: "cli_1" },
      },
      deps
    )
    expect(deps.call).toHaveBeenCalledWith("lark_result_complete", {
      requestId: "req_1",
      result: { conversationKey: "lark:lk-1:oc_9", surface: "chat_tab" },
    })
  })

  it("denies non-members with a deny code + audit", async () => {
    const deps = makeDeps({
      tenantRequest: jest.fn(async () => ({
        data: { items: [{ member_id: "ou_other" }], has_more: false },
      })) as never,
    })
    await handleLarkIntentFrame(
      {
        kind: "resolve_surface",
        requestId: "req_2",
        adapterId: "lk-1",
        chatId: "oc_9",
        verifiedIdentity: { openId: "ou_alice" },
      },
      deps
    )
    expect(deps.call).toHaveBeenCalledWith("lark_result_complete", {
      requestId: "req_2",
      error: "membership_denied",
    })
    expect((deps.audit.mock.calls[0][0] as { kind: string }).kind).toBe("entry.denied")
  })

  it("rejects malformed frames and survives API failures", async () => {
    const deps = makeDeps()
    await handleLarkIntentFrame(
      { kind: "resolve_surface", requestId: "req_3", verifiedIdentity: {} },
      deps
    )
    expect(deps.call).toHaveBeenCalledWith("lark_result_complete", {
      requestId: "req_3",
      error: "intent_malformed",
    })

    const failing = makeDeps({
      tenantRequest: jest.fn(async () => {
        throw new Error("boom")
      }) as never,
    })
    await handleLarkIntentFrame(
      {
        kind: "resolve_surface",
        requestId: "req_4",
        adapterId: "lk-1",
        chatId: "oc_9",
        verifiedIdentity: { openId: "ou_alice" },
      },
      failing
    )
    expect(failing.call).toHaveBeenCalledWith("lark_result_complete", {
      requestId: "req_4",
      error: "membership_check_failed",
    })
  })
})

describe("isChatMember", () => {
  it("pages through the member list until a hit", async () => {
    const pages = [
      { data: { items: [{ member_id: "ou_1" }], has_more: true, page_token: "p2" } },
      { data: { items: [{ member_id: "ou_target" }], has_more: false } },
    ]
    let call = 0
    const deps = makeDeps({
      tenantRequest: jest.fn(async (_c: unknown, _m: unknown, path: string) => {
        if (call === 1) expect(path).toContain("page_token=p2")
        return pages[call++]
      }) as never,
    })
    expect(await isChatMember(deps, "lk-1", "oc_9", "ou_target")).toBe(true)
    expect(call).toBe(2)
  })

  it("throws when credentials are missing", async () => {
    const deps = makeDeps({ keyringGet: jest.fn(async () => null) as never })
    await expect(isChatMember(deps, "lk-1", "oc_9", "ou_x")).rejects.toThrow(
      /credentials unavailable/
    )
  })
})

describe("installLarkIntentHandler", () => {
  it("subscribes to the intent topic and disposes cleanly", async () => {
    const unlisten = jest.fn()
    let captured: ((event: { payload: unknown }) => void) | undefined
    const listen = jest.fn(async (topic: string, handler: (e: { payload: unknown }) => void) => {
      expect(topic).toBe(LARK_INTENT_TOPIC)
      captured = handler
      return unlisten
    })
    const markConsumed = jest.fn(async () => undefined)
    const dispose = installLarkIntentHandler(listen, { markConsumed })
    await new Promise((resolve) => setTimeout(resolve, 0))

    captured?.({ payload: { kind: "entry_consumed", jti: "jti_x" } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(markConsumed).toHaveBeenCalledWith("jti_x")

    dispose()
    expect(unlisten).toHaveBeenCalled()
  })
})
