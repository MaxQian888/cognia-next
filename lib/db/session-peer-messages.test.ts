import "fake-indexeddb/auto"

import {
  __enableDbRuntimeForTesting,
  __resetDbForTesting,
  getDb,
  LEGACY_COGNIA_DB_NAME,
} from "./schema"
import {
  createSessionPeerMessage,
  expireSessionPeerMessages,
  getSessionPeerMessage,
  listSessionInbox,
  listSessionOutbox,
  transitionSessionPeerMessage,
} from "./session-peer-messages"

describe("session peer message persistence", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    __resetDbForTesting()
    await indexedDB.deleteDatabase(LEGACY_COGNIA_DB_NAME)
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("persists agent-origin text with immutable sender, receiver, and authority", async () => {
    const row = await createSessionPeerMessage({
      id: "peer-1",
      senderSessionId: "sender-1",
      receiverSessionId: "receiver-1",
      content: "Review the migration boundary",
      intent: "trigger_turn",
      origin: "agent",
      createdAt: 100,
      expiresAt: 1_000,
    })

    expect(row).toMatchObject({
      id: "peer-1",
      senderSessionId: "sender-1",
      receiverSessionId: "receiver-1",
      content: "Review the migration boundary",
      intent: "trigger_turn",
      origin: "agent",
      authority: "untrusted_agent_message",
      status: "queued",
      createdAt: 100,
      updatedAt: 100,
      expiresAt: 1_000,
    })
    expect(await getSessionPeerMessage("peer-1")).toEqual(row)
  })

  it("pages inbox and outbox newest-first without crossing session boundaries", async () => {
    for (const [id, senderSessionId, receiverSessionId, createdAt] of [
      ["first", "sender-1", "receiver-1", 100],
      ["second", "sender-1", "receiver-1", 200],
      ["other", "sender-2", "receiver-2", 300],
    ] as const) {
      await createSessionPeerMessage({
        id,
        senderSessionId,
        receiverSessionId,
        content: id,
        intent: "note",
        origin: "user",
        createdAt,
        expiresAt: 1_000,
      })
    }

    expect((await listSessionInbox("receiver-1")).map((row) => row.id)).toEqual(["second", "first"])
    expect((await listSessionOutbox("sender-1")).map((row) => row.id)).toEqual(["second", "first"])
  })

  it("enforces lifecycle transitions and keeps terminal receipts terminal", async () => {
    await createSessionPeerMessage({
      id: "peer-2",
      senderSessionId: "sender-1",
      receiverSessionId: "receiver-1",
      content: "A narrow note",
      intent: "note",
      origin: "agent",
      createdAt: 100,
      expiresAt: 1_000,
    })

    await transitionSessionPeerMessage("peer-2", "held", 110)
    await transitionSessionPeerMessage("peer-2", "queued", 120)
    await transitionSessionPeerMessage("peer-2", "delivered", 130)

    expect(await getSessionPeerMessage("peer-2")).toMatchObject({
      status: "delivered",
      updatedAt: 130,
      deliveredAt: 130,
    })
    await expect(transitionSessionPeerMessage("peer-2", "refused", 140)).rejects.toThrow(
      "Cannot transition session peer message peer-2 from delivered to refused"
    )
  })

  it("expires only outstanding messages at their own watermark", async () => {
    for (const [id, expiresAt] of [
      ["expired", 99],
      ["live", 101],
      ["delivered", 50],
    ] as const) {
      await createSessionPeerMessage({
        id,
        senderSessionId: "sender-1",
        receiverSessionId: "receiver-1",
        content: id,
        intent: "note",
        origin: "agent",
        createdAt: 10,
        expiresAt,
      })
    }
    await transitionSessionPeerMessage("delivered", "delivered", 20)

    expect(await expireSessionPeerMessages(100)).toBe(1)
    expect((await getSessionPeerMessage("expired"))?.status).toBe("expired")
    expect((await getSessionPeerMessage("live"))?.status).toBe("queued")
    expect((await getSessionPeerMessage("delivered"))?.status).toBe("delivered")
  })
})
