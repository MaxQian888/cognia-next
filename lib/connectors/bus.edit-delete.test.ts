/** @jest-environment jsdom */
/**
 * Tests for ConnectorBus.applyMessageEdit / applyMessageDelete after the
 * v49 messages.platformMessageId index landed. These previously used
 * `db.messages.toArray()` + `.find()` which O(n)-scanned every message in
 * the system for each edit/delete event. The new implementation does an
 * indexed lookup with a platform-safety filter.
 *
 * The tests assert:
 *   1. An edit event updates the matching row's parts + metadata.editedAt /
 *      editCount.
 *   2. A delete event soft-deletes the matching row (parts replaced with
 *      "[deleted]", metadata.deletedAt set).
 *   3. Cross-platform collision is rejected by the safety filter: a
 *      Telegram edit for messageId=12345 must NOT match a Discord row
 *      that happens to carry the same platformMessageId.
 *   4. `db.messages.toArray()` is never called — proves the implementation
 *      uses the index (regression guard for "did the optimization survive?").
 */

import "fake-indexeddb/auto"
import { getBus, __resetBusForTesting } from "./bus"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { NormalizedInboundEvent } from "@/types/connectors"
import type { StoredMessage } from "@/lib/claude/types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  __resetBusForTesting()
})

function makeStoredMessage(
  overrides: Partial<StoredMessage> & {
    id: string
    platformMessageId: string
    platform: import("@/types/connectors/platform-kind").PlatformKind
  }
): StoredMessage {
  const now = Date.now()
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? "s-test",
    role: "user",
    parts: [{ type: "text", text: "original" }],
    platformMessageId: overrides.platformMessageId,
    metadata: {
      platformMessage: {
        messageId: overrides.platformMessageId,
        platform: overrides.platform,
        sender: {
          id: "u_1",
          platform: overrides.platform,
          adapterId: "a_test",
          remoteUserId: "u_1",
        },
      },
    },
    createdAt: now,
  }
}

function makeEditEvent(
  platform: "telegram" | "discord",
  messageId: string,
  newText: string
): NormalizedInboundEvent {
  return {
    kind: "edit",
    platform,
    adapterId: `${platform}-test`,
    selfId: "bot",
    messageId: `${messageId}-edit-event`,
    replacesMessageId: messageId,
    conversationRef: { platform, adapterId: `${platform}-test` },
    conversationKey: `${platform}:${platform}-test:42`,
    sender: { id: "u_1", platform, adapterId: `${platform}-test`, remoteUserId: "u_1" },
    channel: { id: "ch_1", kind: "private" },
    segments: [{ type: "text", text: newText }],
    plainText: newText,
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  } as unknown as NormalizedInboundEvent
}

function makeDeleteEvent(
  platform: "telegram" | "discord",
  messageId: string
): NormalizedInboundEvent {
  return {
    kind: "delete",
    platform,
    adapterId: `${platform}-test`,
    selfId: "bot",
    messageId: `${messageId}-delete-event`,
    replacesMessageId: messageId,
    conversationRef: { platform, adapterId: `${platform}-test` },
    conversationKey: `${platform}:${platform}-test:42`,
    sender: { id: "u_1", platform, adapterId: `${platform}-test`, remoteUserId: "u_1" },
    channel: { id: "ch_1", kind: "private" },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  } as unknown as NormalizedInboundEvent
}

describe("ConnectorBus.applyMessageEdit (v49 indexed lookup)", () => {
  it("updates the matching row's parts and bumps editCount", async () => {
    const db = getDb()
    await db.messages.put(
      makeStoredMessage({ id: "msg-1", platformMessageId: "tg:42", platform: "telegram" })
    )

    const bus = getBus()
    await bus.dispatchInboundFull(makeEditEvent("telegram", "tg:42", "edited text"))

    const updated = await db.messages.get("msg-1")
    expect(updated?.parts).toEqual([{ type: "text", text: "edited text" }])
    expect(updated?.metadata?.editedAt).toBeDefined()
    expect(updated?.metadata?.editCount).toBe(1)
  })

  it("does not match across platforms (Telegram edit cannot hit Discord row)", async () => {
    const db = getDb()
    // Both rows share the same platformMessageId but live on different
    // platforms — the safety filter must keep them separate.
    await db.messages.bulkPut([
      makeStoredMessage({ id: "tg-row", platformMessageId: "shared-id", platform: "telegram" }),
      makeStoredMessage({ id: "dc-row", platformMessageId: "shared-id", platform: "discord" }),
    ])

    const bus = getBus()
    await bus.dispatchInboundFull(makeEditEvent("telegram", "shared-id", "tg edit"))

    const tg = await db.messages.get("tg-row")
    const dc = await db.messages.get("dc-row")
    expect(tg?.parts).toEqual([{ type: "text", text: "tg edit" }])
    // Discord row must be untouched.
    expect(dc?.parts).toEqual([{ type: "text", text: "original" }])
    expect(dc?.metadata?.editedAt).toBeUndefined()
  })

  it("does not call db.messages.toArray (regression guard for the index)", async () => {
    const db = getDb()
    await db.messages.put(
      makeStoredMessage({ id: "msg-spy", platformMessageId: "spy-1", platform: "telegram" })
    )
    const toArraySpy = jest.spyOn(db.messages, "toArray")

    const bus = getBus()
    await bus.dispatchInboundFull(makeEditEvent("telegram", "spy-1", "spy edit"))

    expect(toArraySpy).not.toHaveBeenCalled()
    toArraySpy.mockRestore()
  })

  it("is a no-op (audit-only) when no row matches the replacesMessageId", async () => {
    const bus = getBus()
    // Nothing seeded — edit should not throw and the audit row records matched=false.
    await expect(
      bus.dispatchInboundFull(makeEditEvent("telegram", "ghost", "phantom"))
    ).resolves.toBeUndefined()
  })
})

describe("ConnectorBus.applyMessageDelete (v49 indexed lookup)", () => {
  it("soft-deletes the matching row", async () => {
    const db = getDb()
    await db.messages.put(
      makeStoredMessage({ id: "msg-del", platformMessageId: "tg:99", platform: "telegram" })
    )

    const bus = getBus()
    await bus.dispatchInboundFull(makeDeleteEvent("telegram", "tg:99"))

    const updated = await db.messages.get("msg-del")
    expect(updated?.parts).toEqual([{ type: "text", text: "[deleted]" }])
    expect(updated?.metadata?.deletedAt).toBeDefined()
  })

  it("does not cross platforms", async () => {
    const db = getDb()
    await db.messages.bulkPut([
      makeStoredMessage({ id: "tg-del", platformMessageId: "id-x", platform: "telegram" }),
      makeStoredMessage({ id: "dc-del", platformMessageId: "id-x", platform: "discord" }),
    ])

    const bus = getBus()
    await bus.dispatchInboundFull(makeDeleteEvent("telegram", "id-x"))

    const tg = await db.messages.get("tg-del")
    const dc = await db.messages.get("dc-del")
    expect(tg?.metadata?.deletedAt).toBeDefined()
    expect(dc?.metadata?.deletedAt).toBeUndefined()
    expect(dc?.parts).toEqual([{ type: "text", text: "original" }])
  })

  it("does not call db.messages.toArray", async () => {
    const db = getDb()
    await db.messages.put(
      makeStoredMessage({ id: "del-spy", platformMessageId: "del-1", platform: "telegram" })
    )
    const toArraySpy = jest.spyOn(db.messages, "toArray")

    const bus = getBus()
    await bus.dispatchInboundFull(makeDeleteEvent("telegram", "del-1"))

    expect(toArraySpy).not.toHaveBeenCalled()
    toArraySpy.mockRestore()
  })
})
