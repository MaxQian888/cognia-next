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

import { getBus, __resetBusForTesting } from "./bus"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { NormalizedInboundEvent } from "@/types/connectors"
import type { StoredMessage } from "@cognia/agent-config-types"

// 30s hook budget: the first cold open of the full schema (100+ Dexie
// versions) can exceed jest's default 5s under parallel suite load.
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetBusForTesting()
})
afterAll(dbFixture.dispose)

function makeStoredMessage(
  overrides: Partial<StoredMessage> & {
    id: string
    platformMessageId: string
    platform: import("@/types/connectors/platform-kind").PlatformKind
    /**
     * Scoping fields written by post-fix rows. Omit to fabricate a LEGACY
     * row (platform-only metadata) and exercise the backward-compat match.
     */
    scope?: { adapterId: string; conversationKey: string }
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
        ...(overrides.scope ?? {}),
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

describe("ConnectorBus.applyMessageEdit — adapter/conversation scoping", () => {
  it("does not rewrite another chat's message with the same per-chat id", async () => {
    const db = getDb()
    // Telegram message_id is unique per CHAT: two chats on the SAME adapter
    // can hold the same id. The pre-fix platform-only filter rewrote
    // whichever row happened to come first.
    await db.messages.bulkPut([
      makeStoredMessage({
        id: "chat42-row",
        platformMessageId: "555",
        platform: "telegram",
        scope: { adapterId: "telegram-test", conversationKey: "telegram:telegram-test:42" },
      }),
      makeStoredMessage({
        id: "chat99-row",
        platformMessageId: "555",
        platform: "telegram",
        scope: { adapterId: "telegram-test", conversationKey: "telegram:telegram-test:99" },
      }),
    ])

    const bus = getBus()
    // makeEditEvent targets conversationKey telegram:telegram-test:42.
    await bus.dispatchInboundFull(makeEditEvent("telegram", "555", "edited in 42"))

    expect((await db.messages.get("chat42-row"))?.parts).toEqual([
      { type: "text", text: "edited in 42" },
    ])
    expect((await db.messages.get("chat99-row"))?.parts).toEqual([
      { type: "text", text: "original" },
    ])
  })

  it("does not rewrite another adapter instance's message (multi-bot)", async () => {
    const db = getDb()
    await db.messages.put(
      makeStoredMessage({
        id: "other-bot-row",
        platformMessageId: "777",
        platform: "telegram",
        scope: { adapterId: "other-bot", conversationKey: "telegram:other-bot:42" },
      })
    )
    const bus = getBus()
    await bus.dispatchInboundFull(makeEditEvent("telegram", "777", "hijack attempt"))
    expect((await db.messages.get("other-bot-row"))?.parts).toEqual([
      { type: "text", text: "original" },
    ])
  })

  it("legacy row (no scoping fields) still matches on platform (backward compat)", async () => {
    const db = getDb()
    await db.messages.put(
      makeStoredMessage({ id: "legacy-row", platformMessageId: "888", platform: "telegram" })
    )
    const bus = getBus()
    await bus.dispatchInboundFull(makeEditEvent("telegram", "888", "legacy edit"))
    expect((await db.messages.get("legacy-row"))?.parts).toEqual([
      { type: "text", text: "legacy edit" },
    ])
  })

  it("prefers the fully-scoped row when a legacy row shares the id", async () => {
    const db = getDb()
    await db.messages.bulkPut([
      makeStoredMessage({ id: "legacy-shared", platformMessageId: "999", platform: "telegram" }),
      makeStoredMessage({
        id: "scoped-shared",
        platformMessageId: "999",
        platform: "telegram",
        scope: { adapterId: "telegram-test", conversationKey: "telegram:telegram-test:42" },
      }),
    ])
    const bus = getBus()
    await bus.dispatchInboundFull(makeEditEvent("telegram", "999", "scoped wins"))
    expect((await db.messages.get("scoped-shared"))?.parts).toEqual([
      { type: "text", text: "scoped wins" },
    ])
    expect((await db.messages.get("legacy-shared"))?.parts).toEqual([
      { type: "text", text: "original" },
    ])
  })
})

describe("ConnectorBus.applySystemEvent — reaction / poke system kinds", () => {
  function makeSystemEvent(systemKind: string): NormalizedInboundEvent {
    return {
      ...makeEditEvent("telegram", "ignored", ""),
      kind: "system",
      replacesMessageId: undefined,
      systemKind,
    } as unknown as NormalizedInboundEvent
  }

  it("reaction_added / reaction_removed / poke are silent no-ops, not adapter.error", async () => {
    const bus = getBus()
    for (const sk of ["reaction_added", "reaction_removed", "poke"]) {
      await bus.dispatchInboundFull(makeSystemEvent(sk))
    }
    const audit = await getDb().connectorAudit.toArray()
    // Pre-fix these audited "adapter.error / unknown_system_kind:…" per
    // user gesture — pure noise. Now: no audit row at all.
    expect(audit.filter((r) => r.kind === "adapter.error")).toHaveLength(0)
  })

  it("a genuinely unknown systemKind still audits adapter.error (schema-gap tripwire)", async () => {
    const bus = getBus()
    await bus.dispatchInboundFull(makeSystemEvent("teleport"))
    const audit = await getDb().connectorAudit.toArray()
    expect(
      audit.some((r) => r.kind === "adapter.error" && r.reason === "unknown_system_kind:teleport")
    ).toBe(true)
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
