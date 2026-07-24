/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { issueEntryToken, issueSurfaceToken } from "./tokens"

const INPUT = {
  adapterId: "lk-1",
  principalId: "fp_1",
  accountId: "acct_a",
  openId: "ou_alice",
  tenantKey: "tk_a",
  appId: "cli_1",
  entryType: "bot_menu",
  conversationKey: "lark:lk-1:oc_1",
  sessionId: "sess_1",
}

describe("entry token issuance", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("mints via the companion RPC and writes the ledger row", async () => {
    const call = jest.fn(async (_name: string, _args?: Record<string, unknown>) => ({
      token: "jwt_x",
      jti: "jti_x",
      expiresAt: 1_753_000_300_000,
    })) as never
    const issued = await issueEntryToken(INPUT, { call })
    expect(issued.token).toBe("jwt_x")

    const [name, args] = (call as jest.Mock).mock.calls[0]
    expect(name).toBe("lark_entry_issue")
    expect(args).toMatchObject({ kind: "entry", openId: "ou_alice", sessionId: "sess_1" })

    const ledger = await getDb().larkEntryContexts.get("jti_x")
    expect(ledger).toMatchObject({
      adapterId: "lk-1",
      principalId: "fp_1",
      entryType: "bot_menu",
      conversationKey: "lark:lk-1:oc_1",
      expiresAt: 1_753_000_300_000,
    })
  })

  it("propagates RPC failures", async () => {
    const call = jest.fn(async () => {
      throw new Error("companion down")
    }) as never
    await expect(issueEntryToken(INPUT, { call })).rejects.toThrow("companion down")
    expect(await getDb().larkEntryContexts.count()).toBe(0)
  })

  it("mints surface tokens without a ledger row", async () => {
    const call = jest.fn(async () => ({ token: "surface_jwt" })) as never
    const token = await issueSurfaceToken(
      {
        adapterId: "lk-1",
        tenantKey: "tk_a",
        appId: "cli_1",
        chatId: "oc_9",
        urlVersion: 2,
        surface: "chat_tab",
      },
      { call }
    )
    expect(token).toBe("surface_jwt")
    const [, args] = (call as jest.Mock).mock.calls[0]
    expect(args).toMatchObject({ kind: "surface", chatId: "oc_9", urlVersion: 2 })
    expect(await getDb().larkEntryContexts.count()).toBe(0)
  })
})
