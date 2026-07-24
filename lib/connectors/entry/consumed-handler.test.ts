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
    importMessages: jest.fn(async () => ({
      ok: true as const,
      sessionId: "sess_i",
      conversationKey: "lark:lk-1:oc_1",
      imported: 2,
      skipped: [],
      replay: false,
    })),
    plusCreate: jest.fn(async () => ({
      ok: true as const,
      conversationKey: "lark:lk-1:oc_1",
      sessionId: "sess_p",
    })),
    ...overrides,
  } as LarkIntentDependencies & {
    call: jest.Mock
    keyringGet: jest.Mock
    tenantRequest: jest.Mock
    markConsumed: jest.Mock
    audit: jest.Mock
    importMessages: jest.Mock
    plusCreate: jest.Mock
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

  it("routes import_messages to the importer and answers with its result", async () => {
    const deps = makeDeps()
    await handleLarkIntentFrame(
      {
        kind: "import_messages",
        requestId: "req_i",
        adapterId: "lk-1",
        chatId: "oc_1",
        messageIds: ["om_1", "om_2"],
        triggerId: "trig_1",
        verifiedIdentity: { openId: "ou_alice", tenantKey: "tk_a", appId: "cli_1" },
      },
      deps
    )
    expect(deps.importMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "lk-1",
        chatId: "oc_1",
        messageIds: ["om_1", "om_2"],
        triggerId: "trig_1",
        verifiedIdentity: { openId: "ou_alice", tenantKey: "tk_a", appId: "cli_1" },
      }),
      expect.objectContaining({ isMember: expect.any(Function) })
    )
    expect(deps.call).toHaveBeenCalledWith("lark_result_complete", {
      requestId: "req_i",
      result: expect.objectContaining({ sessionId: "sess_i", imported: 2 }),
    })
    const auditKinds = deps.audit.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(auditKinds).toContain("sso.session_seen")
  })

  it("maps importer denials onto intent errors", async () => {
    const deps = makeDeps({
      importMessages: jest.fn(async () => ({
        ok: false as const,
        error: "membership_denied",
      })) as never,
    })
    await handleLarkIntentFrame(
      {
        kind: "import_messages",
        requestId: "req_id",
        adapterId: "lk-1",
        chatId: "oc_1",
        messageIds: ["om_1"],
        verifiedIdentity: { openId: "ou_mallory" },
      },
      deps
    )
    expect(deps.call).toHaveBeenCalledWith("lark_result_complete", {
      requestId: "req_id",
      error: "membership_denied",
    })
  })

  it("routes plus_create and rejects frames without identity", async () => {
    const deps = makeDeps()
    await handleLarkIntentFrame(
      {
        kind: "plus_create",
        requestId: "req_p",
        adapterId: "lk-1",
        chatId: "oc_2",
        verifiedIdentity: { openId: "ou_alice" },
      },
      deps
    )
    expect(deps.plusCreate).toHaveBeenCalled()
    expect(deps.call).toHaveBeenCalledWith("lark_result_complete", {
      requestId: "req_p",
      result: { conversationKey: "lark:lk-1:oc_1", sessionId: "sess_p" },
    })

    const anonymous = makeDeps()
    await handleLarkIntentFrame(
      { kind: "plus_create", requestId: "req_q", adapterId: "lk-1", verifiedIdentity: {} },
      anonymous
    )
    expect(anonymous.call).toHaveBeenCalledWith("lark_result_complete", {
      requestId: "req_q",
      error: "intent_malformed",
    })
    expect(anonymous.plusCreate).not.toHaveBeenCalled()
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
