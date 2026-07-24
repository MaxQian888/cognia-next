/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { handlePlusCreate, sessionSeed, type PlusCreateDependencies } from "./plus-create"

const ADAPTER_ID = "lark-plus-1"
const CHAT_ID = "oc_plus_1"
const IDENTITY = { openId: "ou_alice", tenantKey: "tk_a", appId: "cli_1" }

function adapterRow(settings: Record<string, unknown> = { larkPlusMenu: true }) {
  return { id: ADAPTER_ID, platform: "lark", settings } as unknown as AdapterInstanceRow
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getAdapter: jest.fn(async () => adapterRow()),
    isMember: jest.fn(async () => true),
    audit: jest.fn(async () => undefined),
    now: () => 1_700_000_000_000,
    ...overrides,
  } as unknown as Partial<PlusCreateDependencies> & { isMember: jest.Mock; audit: jest.Mock }
}

describe("handlePlusCreate", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("denies when the larkPlusMenu flag is off", async () => {
    const deps = makeDeps({ getAdapter: jest.fn(async () => adapterRow({})) })
    expect(
      await handlePlusCreate(
        { adapterId: ADAPTER_ID, chatId: CHAT_ID, verifiedIdentity: IDENTITY },
        deps
      )
    ).toEqual({ ok: false, error: "feature_disabled" })
  })

  it("requires a chat id and chat membership", async () => {
    expect(
      await handlePlusCreate({ adapterId: ADAPTER_ID, verifiedIdentity: IDENTITY }, makeDeps())
    ).toEqual({ ok: false, error: "chat_missing" })

    const outsider = makeDeps({ isMember: jest.fn(async () => false) })
    expect(
      await handlePlusCreate(
        { adapterId: ADAPTER_ID, chatId: CHAT_ID, verifiedIdentity: IDENTITY },
        outsider
      )
    ).toEqual({ ok: false, error: "membership_denied" })
  })

  it("binds a fresh session to the chat conversation and audits", async () => {
    const deps = makeDeps()
    const outcome = await handlePlusCreate(
      { adapterId: ADAPTER_ID, chatId: CHAT_ID, verifiedIdentity: IDENTITY },
      deps
    )
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error}`)
    expect(outcome.conversationKey).toBe(`lark:${ADAPTER_ID}:${CHAT_ID}`)
    const session = await getDb().sessions.get(outcome.sessionId)
    expect(session?.platformBinding?.adapterId).toBe(ADAPTER_ID)
    expect(session?.platformConversationKey).toBe(outcome.conversationKey)
    expect((deps.audit.mock.calls[0][0] as { kind: string }).kind).toBe("plus.create")

    // A second invocation creates a SECOND session (that is the /new
    // semantics the + menu mirrors), both bound to the same conversation.
    const again = await handlePlusCreate(
      { adapterId: ADAPTER_ID, chatId: CHAT_ID, verifiedIdentity: IDENTITY },
      makeDeps()
    )
    if (!again.ok) throw new Error("expected ok")
    expect(again.sessionId).not.toBe(outcome.sessionId)
    expect(await getDb().sessions.count()).toBe(2)
  })

  it("fails closed on unbound principals when the registry flag is on", async () => {
    const deps = makeDeps({
      getAdapter: jest.fn(async () =>
        adapterRow({ larkPlusMenu: true, larkPrincipalRegistry: true })
      ),
    })
    const outcome = await handlePlusCreate(
      { adapterId: ADAPTER_ID, chatId: CHAT_ID, verifiedIdentity: IDENTITY },
      deps
    )
    expect(outcome).toEqual({ ok: false, error: "principal_unbound" })
  })

  it("maps membership API failures onto membership_check_failed", async () => {
    const deps = makeDeps({
      isMember: jest.fn(async () => {
        throw new Error("members down")
      }),
    })
    expect(
      await handlePlusCreate(
        { adapterId: ADAPTER_ID, chatId: CHAT_ID, verifiedIdentity: IDENTITY },
        deps
      )
    ).toEqual({ ok: false, error: "membership_check_failed" })
  })

  it("attributes the seed to the verified clicker, not the chat", async () => {
    // The seed used to set `sender.remoteUserId = chatId`, which left the run
    // with no actor to authorize against and mis-attributed the audit trail.
    const seed = sessionSeed(ADAPTER_ID, CHAT_ID, IDENTITY.openId)

    expect(seed.sender.remoteUserId).toBe(IDENTITY.openId)
    expect(seed.sender.id).toBe(`lark:${IDENTITY.openId}`)
    // The conversation still binds to the chat — only the actor changed.
    expect(seed.conversationRef.channelId).toBe(CHAT_ID)
    expect(seed.conversationKey).toBe(`lark:${ADAPTER_ID}:${CHAT_ID}`)
  })

  it("writes the plus.create audit on success", async () => {
    const deps = makeDeps()
    const outcome = await handlePlusCreate(
      { adapterId: ADAPTER_ID, chatId: CHAT_ID, verifiedIdentity: IDENTITY },
      deps
    )
    expect(outcome.ok).toBe(true)
    const created = deps.audit.mock.calls.find(
      (call) => (call[0] as { kind: string }).kind === "plus.create"
    )
    expect(created).toBeDefined()
    expect(JSON.stringify(created?.[0])).not.toContain(IDENTITY.openId)
  })

  it("audits every denial so a silently refusing + menu is visible", async () => {
    const cases: Array<[Partial<Record<string, unknown>>, Record<string, unknown>, string]> = [
      [
        { getAdapter: jest.fn(async () => adapterRow({})) },
        { chatId: CHAT_ID },
        "feature_disabled",
      ],
      [{}, {}, "chat_missing"],
      [{ isMember: jest.fn(async () => false) }, { chatId: CHAT_ID }, "membership_denied"],
      [
        {
          isMember: jest.fn(async () => {
            throw new Error("api down")
          }),
        },
        { chatId: CHAT_ID },
        "membership_check_failed",
      ],
    ]

    for (const [overrides, input, expected] of cases) {
      const deps = makeDeps(overrides)
      const outcome = await handlePlusCreate(
        { adapterId: ADAPTER_ID, verifiedIdentity: IDENTITY, ...input },
        deps
      )
      expect(outcome).toEqual({ ok: false, error: expected })
      const denied = deps.audit.mock.calls.find(
        (call) => (call[0] as { kind: string }).kind === "plus.create_denied"
      )
      expect(denied?.[0]).toMatchObject({ reason: expected })
      // The raw open_id never lands in the audit log.
      expect(JSON.stringify(denied?.[0])).not.toContain(IDENTITY.openId)
    }
  })
})
