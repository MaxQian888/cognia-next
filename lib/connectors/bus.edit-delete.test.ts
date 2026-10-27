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
import {
  parseLarkEventEnvelope,
  type LarkEventEnvelope,
} from "@/lib/connectors/adapters/lark/parse"
import larkMessageFixture from "@/lib/connectors/adapters/lark/fixtures/dm-text.json"
import { parseMatrixEvent } from "./adapters/matrix/parse"
import { insertInboundMessage } from "./runtime"
import {
  enqueueConnectorInboundJob,
  completeConnectorInboundJob,
  recordConnectorInboundEdit,
  recordConnectorInboundRecall,
} from "@/lib/db/connector-inbound-jobs"

// 30s hook budget: the first cold open of the full schema (100+ Dexie
// versions) can exceed jest's default 5s under parallel suite load.
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetBusForTesting()
  // Every fabricated row lives in "s-test". Edit and delete refuse a row whose
  // conversation is gone (SESSION_NOT_FOUND), so the conversation must exist.
  await getDb().sessions.add({
    id: "s-test",
    title: "t",
    createdAt: 1,
    updatedAt: 1,
    platformConversationKey: "telegram:telegram-test:42",
  } as never)
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
  it("keeps a recall-before-create fence through restart within the retained window", async () => {
    const create = {
      ...makeEditEvent("telegram", "delayed", "original"),
      kind: "create" as const,
      messageId: "delayed",
      replacesMessageId: undefined,
    }
    const recall = {
      ...create,
      kind: "delete" as const,
      messageId: "recall",
      replacesMessageId: create.messageId,
    }
    await recordConnectorInboundRecall(recall, Date.now())
    getDb().close()
    await getDb().open()
    __resetBusForTesting()
    const dispatch = jest.fn()
    getBus().routeHandler = dispatch
    await getBus().resumeDurableInboundJobs({ reclaimRunning: true })
    const source = await insertInboundMessage(create, "s-test")
    expect(source.parts).toEqual([{ type: "text", text: "[deleted]" }])
    expect(source.metadata?.deletedAt).toBeDefined()
    expect((await getDb().sessionState.get("s-test"))?.unreadCount ?? 0).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("keeps the available legacy baseline when the first tracked Matrix edit is redacted", async () => {
    const source = makeStoredMessage({
      id: "legacy-matrix",
      platform: "matrix",
      platformMessageId: "!room:s|$original",
      scope: { adapterId: "matrix-test", conversationKey: "matrix:matrix-test:!room:s" },
    })
    source.parts = [{ type: "text", text: "last known legacy content" }]
    source.metadata = { ...source.metadata, editedAt: 10, editCount: 2 }
    await getDb().messages.put(source)
    const edit = {
      ...makeEditEvent("telegram", source.platformMessageId!, "new edit"),
      platform: "matrix" as const,
      adapterId: "matrix-test",
      conversationKey: "matrix:matrix-test:!room:s",
      messageId: "!room:s|$edit",
      timestamp: 20,
      raw: { event_id: "$edit" },
    }
    await getBus().dispatchInboundFull(edit)
    await getBus().dispatchInboundFull({
      ...edit,
      kind: "delete",
      messageId: "!room:s|$redact",
      replacesMessageId: edit.messageId,
      timestamp: 30,
    })
    expect((await getDb().messages.get(source.id))?.parts).toEqual(source.parts)
  })
  it.each([
    ["create", "edit1", "recall1"],
    ["edit1", "recall1", "create"],
    ["recall1", "edit1", "create"],
    ["create", "edit2", "edit1", "recall2"],
    ["create", "edit1", "edit2", "recall2", "recall1"],
  ])("selects unredacted Matrix content for %j", async (...order: string[]) => {
    const create = parseMatrixEvent("matrix-test", "@bot:s", "!room:s", {
      type: "m.room.message",
      event_id: "$original",
      sender: "@alice:s",
      origin_server_ts: 1,
      content: { msgtype: "m.text", body: "original" },
    })!
    const edit = (n: number) =>
      parseMatrixEvent("matrix-test", "@bot:s", "!room:s", {
        type: "m.room.message",
        event_id: `$edit${n}`,
        sender: "@alice:s",
        origin_server_ts: n + 1,
        content: {
          msgtype: "m.text",
          body: `* edit${n}`,
          "m.new_content": { msgtype: "m.text", body: `edit${n}` },
          "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
        },
      })!
    const recall = (n: number) =>
      parseMatrixEvent("matrix-test", "@bot:s", "!room:s", {
        type: "m.room.redaction",
        event_id: `$redact${n}`,
        sender: "@alice:s",
        origin_server_ts: 10 + n,
        redacts: `$edit${n}`,
        content: {},
      })!
    for (const action of order) {
      if (action === "create") await insertInboundMessage(create, "s-test")
      else
        await getBus().dispatchInboundFull(
          action.startsWith("edit") ? edit(Number(action.at(-1))) : recall(Number(action.at(-1)))
        )
    }
    const source = await getDb()
      .messages.where("platformMessageId")
      .equals(create.messageId)
      .first()
    expect(source?.parts).toEqual([
      {
        type: "text",
        text: order.includes("recall2") && !order.includes("recall1") ? "edit1" : "original",
      },
    ])
    expect(source?.metadata?.deletedAt).toBeUndefined()
    __resetBusForTesting()
    await getBus().resumeDurableInboundJobs({ reclaimRunning: true })
    expect((await getDb().messages.get(source!.id))?.parts).toEqual(source?.parts)
  })
  it.each(
    (["dingtalk", "wecom", "onebot", "qq-official", "matrix"] as const).flatMap((platform) =>
      (["edit", "delete"] as const).map((kind) => [platform, kind] as const)
    )
  )(
    "reconciles committed %s %s intents after a crash before the canonical write",
    async (platform, kind) => {
      const id = `${platform}-${kind}`
      const adapterId = `${platform}-test`
      const conversationKey = `${platform}:${adapterId}:room`
      const original = makeStoredMessage({
        id,
        platformMessageId: id,
        platform,
        scope: { adapterId, conversationKey },
      })
      await getDb().messages.put(original)
      const event = {
        ...makeEditEvent("telegram", id, "latest body"),
        platform,
        adapterId,
        conversationKey,
        kind,
        timestamp: 20,
        raw: { event_id: "$latest" },
        sender: { id: "u_1", platform, adapterId, remoteUserId: "u_1" },
        segments:
          kind === "edit"
            ? [
                { type: "text" as const, text: "latest body" },
                {
                  type: "image" as const,
                  url: "data:image/png;base64,DISPLAY_SENTINEL",
                  mimeType: "image/png",
                },
              ]
            : [],
      }
      const job = await enqueueConnectorInboundJob(
        {
          ...event,
          kind: "create",
          messageId: id,
          timestamp: 1,
          plainText: "original",
          segments: [{ type: "text", text: "original" }],
        },
        "queue"
      )
      await completeConnectorInboundJob(job.id)
      if (kind === "edit") await recordConnectorInboundEdit(event)
      else await recordConnectorInboundRecall(event, 20)
      // Only the intent committed before process death. Reopen the real
      // persisted DB, then drive the production bootstrap recovery entry.
      getDb().close()
      await getDb().open()
      __resetBusForTesting()
      await getBus().resumeDurableInboundJobs({ reclaimRunning: true })
      const recovered = await getDb().messages.get(id)
      expect(recovered?.parts).toEqual(
        kind === "edit"
          ? [
              { type: "text", text: "latest body" },
              { type: "text", text: "[image]" },
            ]
          : [{ type: "text", text: "[deleted]" }]
      )
      expect(JSON.stringify(recovered?.parts)).not.toContain("SENTINEL")
      if (kind === "delete") expect(recovered?.metadata?.deletedAt).toBeDefined()
    }
  )
  it("does not invalidate a later transcript generation for a repeated recall", async () => {
    await getDb().messages.put(
      makeStoredMessage({ id: "repeat-recall", platformMessageId: "parent", platform: "telegram" })
    )
    const recall = makeDeleteEvent("telegram", "parent")
    await getBus().dispatchInboundFull(recall)
    const first = await getDb().messages.get("repeat-recall")
    await getDb().sessions.update("s-test", { runtimeTranscriptGeneration: "later-turn" })
    await getBus().dispatchInboundFull(recall)
    expect((await getDb().messages.get("repeat-recall"))?.metadata?.deletedAt).toBe(
      first?.metadata?.deletedAt
    )
    expect((await getDb().sessions.get("s-test"))?.runtimeTranscriptGeneration).toBe("later-turn")
  })
  it("rejects foreign Matrix edits and orders equal-clock replacements by event id", async () => {
    await getDb().messages.put(
      makeStoredMessage({
        id: "matrix-original",
        platformMessageId: "!room:srv|$original",
        platform: "matrix",
        scope: { adapterId: "matrix-test", conversationKey: "matrix:matrix-test:!room:srv" },
      })
    )
    const edit = {
      ...makeEditEvent("telegram", "!room:srv|$original", "valid"),
      platform: "matrix" as const,
      adapterId: "matrix-test",
      conversationKey: "matrix:matrix-test:!room:srv",
      timestamp: 20,
      raw: { event_id: "$z" },
    }
    await getBus().dispatchInboundFull({
      ...edit,
      sender: { ...edit.sender, remoteUserId: "mallory" },
      plainText: "forged",
      segments: [{ type: "text", text: "forged" }],
    })
    expect((await getDb().messages.get("matrix-original"))?.parts).toEqual([
      { type: "text", text: "original" },
    ])
    await getBus().dispatchInboundFull(edit)
    await getBus().dispatchInboundFull({
      ...edit,
      raw: { event_id: "$a" },
      segments: [{ type: "text", text: "stale" }],
    })
    expect((await getDb().messages.get("matrix-original"))?.parts).toEqual([
      { type: "text", text: "valid" },
    ])
    await getBus().dispatchInboundFull({ ...edit, kind: "delete", messageId: "redaction" })
    await getBus().dispatchInboundFull({ ...edit, timestamp: 30, raw: { event_id: "$zz" } })
    expect((await getDb().messages.get("matrix-original"))?.parts).toEqual([
      { type: "text", text: "[deleted]" },
    ])
  })
  it("rejects older edit revisions including Telegram updates in the same second", async () => {
    await getDb().messages.put(
      makeStoredMessage({ id: "ordered", platformMessageId: "tg:order", platform: "telegram" })
    )
    const newer = {
      ...makeEditEvent("telegram", "tg:order", "newer"),
      timestamp: 2000,
      raw: { update_id: 102 },
    }
    const older = {
      ...makeEditEvent("telegram", "tg:order", "older"),
      timestamp: 2000,
      raw: { update_id: 101 },
    }
    await getBus().dispatchInboundFull(newer)
    await getBus().dispatchInboundFull(older)
    await getBus().dispatchInboundFull({ ...older, timestamp: 1000, raw: {} })
    expect((await getDb().messages.get("ordered"))?.parts).toEqual([
      { type: "text", text: "newer" },
    ])
    expect((await getDb().sessions.get("s-test"))?.lastMessagePreview).toBe("newer")
  })

  it("does not match an unscoped legacy row in another bound conversation", async () => {
    await getDb().sessions.update("s-test", { platformConversationKey: "telegram:other-bot:99" })
    await getDb().messages.put(
      makeStoredMessage({ id: "legacy-other", platformMessageId: "tg:scope", platform: "telegram" })
    )
    await getBus().dispatchInboundFull(makeDeleteEvent("telegram", "tg:scope"))
    expect((await getDb().messages.get("legacy-other"))?.metadata?.deletedAt).toBeUndefined()
  })
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

  it("restamps the session preview when the edited row is the newest message", async () => {
    const db = getDb()
    const row = makeStoredMessage({
      id: "msg-stamp",
      platformMessageId: "tg:61",
      platform: "telegram",
    })
    await db.messages.put(row)

    await getBus().dispatchInboundFull(makeEditEvent("telegram", "tg:61", "fixed typo"))

    // The Inbox list reads the denormalized pair, not the message table, so an
    // edit that skipped the stamp would keep showing the pre-edit text.
    const session = await db.sessions.get("s-test")
    expect(session?.lastMessagePreview).toBe("fixed typo")
    expect(session?.lastMessageAt).toBe(row.createdAt)
  })

  it("leaves a newer preview alone when an older message is edited", async () => {
    const db = getDb()
    const row = makeStoredMessage({
      id: "msg-old",
      platformMessageId: "tg:62",
      platform: "telegram",
    })
    await db.messages.put(row)
    await db.sessions.update("s-test", {
      lastMessagePreview: "newest message",
      lastMessageAt: row.createdAt + 1_000,
    })

    await getBus().dispatchInboundFull(makeEditEvent("telegram", "tg:62", "old edit"))

    expect((await db.messages.get("msg-old"))?.parts).toEqual([{ type: "text", text: "old edit" }])
    const session = await db.sessions.get("s-test")
    expect(session?.lastMessagePreview).toBe("newest message")
    expect(session?.lastMessageAt).toBe(row.createdAt + 1_000)
  })

  it("drops inbound labels that judged the pre-edit text", async () => {
    const db = getDb()
    const row = makeStoredMessage({
      id: "msg-labels",
      platformMessageId: "tg:77",
      platform: "telegram",
    })
    row.metadata = {
      ...row.metadata,
      inboundLabels: [
        { key: "spam", score: 0.9, severity: "high", label: "Spam", source: "laya", at: 1 },
      ],
    }
    await db.messages.put(row)
    await getBus().dispatchInboundFull(makeEditEvent("telegram", "tg:77", "edited"))
    const updated = await db.messages.get("msg-labels")
    expect(updated?.metadata?.editedAt).toBeDefined()
    expect(updated?.metadata).not.toHaveProperty("inboundLabels")
    expect(updated?.metadata?.platformMessage).toBeDefined()
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

  it("leaves a row alone and audits the failure when its conversation is gone", async () => {
    const db = getDb()
    await db.messages.put(
      makeStoredMessage({
        id: "orphan",
        sessionId: "s-gone",
        platformMessageId: "tg:13",
        platform: "telegram",
        scope: { adapterId: "telegram-test", conversationKey: "telegram:telegram-test:42" },
      })
    )
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await getBus().dispatchInboundFull(makeEditEvent("telegram", "tg:13", "edited"))
      await getBus().dispatchInboundFull(makeDeleteEvent("telegram", "tg:13"))
    } finally {
      consoleError.mockRestore()
    }

    const row = await db.messages.get("orphan")
    expect(row?.parts).toEqual([{ type: "text", text: "original" }])
    expect(row?.metadata?.editedAt).toBeUndefined()
    expect(row?.metadata?.deletedAt).toBeUndefined()
    const failures = (await db.connectorAudit.toArray()).filter(
      (entry) => entry.kind === "adapter.error" && entry.reason === "inbound_pipeline_failed"
    )
    expect(failures.map((entry) => entry.message)).toEqual([
      "SESSION_NOT_FOUND",
      "SESSION_NOT_FOUND",
    ])
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

  it("replaces the session preview with the tombstone so the deleted text is gone", async () => {
    const db = getDb()
    const row = makeStoredMessage({
      id: "msg-del-stamp",
      platformMessageId: "tg:63",
      platform: "telegram",
    })
    await db.messages.put(row)
    await db.sessions.update("s-test", {
      lastMessagePreview: "original",
      lastMessageAt: row.createdAt,
    })

    await getBus().dispatchInboundFull(makeDeleteEvent("telegram", "tg:63"))

    const session = await db.sessions.get("s-test")
    expect(session?.lastMessagePreview).toBe("[deleted]")
    expect(session?.lastMessageAt).toBe(row.createdAt)
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

describe("ConnectorBus edit/delete — threads and rich metadata", () => {
  it("applies a real Lark recall envelope to its managed-thread message", async () => {
    const created = parseLarkEventEnvelope(
      "lark-test",
      "self",
      larkMessageFixture as LarkEventEnvelope,
      { replyInThread: true }
    )!
    const row = makeStoredMessage({
      id: "lark-recalled",
      platform: "lark",
      platformMessageId: created.messageId,
      scope: { adapterId: created.adapterId, conversationKey: created.conversationKey },
    })
    await getDb().messages.put(row)
    const recall = parseLarkEventEnvelope("lark-test", "self", {
      schema: "2.0",
      header: { event_id: "recall-event", event_type: "im.message.recalled_v1" },
      event: { chat_id: larkMessageFixture.event.message.chat_id, message_id: created.messageId },
    })!
    expect(recall.conversationKey).not.toBe(created.conversationKey)
    await getBus().dispatchInboundFull(recall)
    expect((await getDb().messages.get(row.id))?.parts).toEqual([
      { type: "text", text: "[deleted]" },
    ])
  })
  const staleBlock = {
    v: 1,
    source: "telegram",
    body: [{ kind: "row", children: [{ kind: "button", label: "Old", actionId: "old" }] }],
  }

  it("matches a row filed under a thread of the event's chat (Lark recall carries no thread)", async () => {
    const db = getDb()
    await db.messages.put(
      makeStoredMessage({
        id: "thread-row",
        platformMessageId: "om_1",
        platform: "telegram",
        scope: {
          adapterId: "telegram-test",
          conversationKey: "telegram:telegram-test:42:om_root",
        },
      })
    )
    await getBus().dispatchInboundFull(makeDeleteEvent("telegram", "om_1"))
    expect((await db.messages.get("thread-row"))?.metadata?.deletedAt).toBeDefined()
  })

  it("does not treat a different chat that shares a key prefix as a thread", async () => {
    const db = getDb()
    await db.messages.put(
      makeStoredMessage({
        id: "chat420-row",
        platformMessageId: "om_2",
        platform: "telegram",
        scope: { adapterId: "telegram-test", conversationKey: "telegram:telegram-test:420" },
      })
    )
    await getBus().dispatchInboundFull(makeDeleteEvent("telegram", "om_2"))
    expect((await db.messages.get("chat420-row"))?.metadata?.deletedAt).toBeUndefined()
  })

  it("prefers the exact conversation over a thread row with the same id", async () => {
    const db = getDb()
    await db.messages.bulkPut([
      makeStoredMessage({
        id: "in-thread",
        platformMessageId: "om_3",
        platform: "telegram",
        scope: { adapterId: "telegram-test", conversationKey: "telegram:telegram-test:42:t1" },
      }),
      makeStoredMessage({
        id: "in-chat",
        platformMessageId: "om_3",
        platform: "telegram",
        scope: { adapterId: "telegram-test", conversationKey: "telegram:telegram-test:42" },
      }),
    ])
    await getBus().dispatchInboundFull(makeEditEvent("telegram", "om_3", "edited"))
    expect((await db.messages.get("in-chat"))?.parts).toEqual([{ type: "text", text: "edited" }])
    expect((await db.messages.get("in-thread"))?.parts).toEqual([
      { type: "text", text: "original" },
    ])
  })

  it("a delete drops the rich block and labels so the withdrawn content is not shown", async () => {
    const db = getDb()
    const row = makeStoredMessage({
      id: "rich-del",
      platformMessageId: "tg:7",
      platform: "telegram",
    })
    row.metadata = {
      ...row.metadata,
      inboundA2UI: staleBlock,
      inboundLabels: [
        { key: "x", score: 1, severity: "high", label: "Flag", source: "test", at: 1 },
      ],
      replyTo: { messageId: "parent", preview: "withdrawn quote" },
    } as StoredMessage["metadata"]
    await db.messages.put(row)
    await getBus().dispatchInboundFull(makeDeleteEvent("telegram", "tg:7"))
    const updated = await db.messages.get("rich-del")
    expect(updated?.metadata?.deletedAt).toBeDefined()
    expect(updated?.metadata?.inboundA2UI).toBeUndefined()
    expect(updated?.metadata?.inboundLabels).toBeUndefined()
    expect(updated?.metadata?.replyTo).toBeUndefined()
    expect(updated?.metadata?.platformMessage).toBeDefined()
  })

  it("an edit re-projects the rich block from the new revision", async () => {
    const db = getDb()
    const row = makeStoredMessage({
      id: "rich-edit",
      platformMessageId: "tg:8",
      platform: "telegram",
    })
    row.metadata = { ...row.metadata, inboundA2UI: staleBlock } as StoredMessage["metadata"]
    await db.messages.put(row)
    const event = makeEditEvent("telegram", "tg:8", "new text")
    event.raw = {
      update_id: 1,
      edited_message: {
        text: "new text",
        reply_markup: { inline_keyboard: [[{ text: "Docs", url: "https://x.test" }]] },
      },
    }
    await getBus().dispatchInboundFull(event)
    const block = (await db.messages.get("rich-edit"))?.metadata?.inboundA2UI as
      { body: unknown[] } | undefined
    expect(block?.body).toEqual([
      { kind: "text", text: "new text" },
      { kind: "row", children: [{ kind: "button", label: "Docs", url: "https://x.test" }] },
    ])
  })

  it("an edit that removes the rich content removes the stale block", async () => {
    const db = getDb()
    const row = makeStoredMessage({
      id: "rich-gone",
      platformMessageId: "tg:9",
      platform: "telegram",
    })
    row.metadata = { ...row.metadata, inboundA2UI: staleBlock } as StoredMessage["metadata"]
    await db.messages.put(row)
    const event = makeEditEvent("telegram", "tg:9", "plain now")
    event.raw = { update_id: 2, edited_message: { text: "plain now" } }
    await getBus().dispatchInboundFull(event)
    const updated = await db.messages.get("rich-gone")
    expect(updated?.parts).toEqual([{ type: "text", text: "plain now" }])
    expect(updated?.metadata?.inboundA2UI).toBeUndefined()
  })

  it("does not resurrect a withdrawn message when a delayed edit arrives", async () => {
    const db = getDb()
    await db.messages.put(
      makeStoredMessage({ id: "late-edit", platformMessageId: "tg:10", platform: "telegram" })
    )
    await getBus().dispatchInboundFull(makeDeleteEvent("telegram", "tg:10"))
    await getBus().dispatchInboundFull(makeEditEvent("telegram", "tg:10", "must stay withdrawn"))
    expect((await db.messages.get("late-edit"))?.parts).toEqual([
      { type: "text", text: "[deleted]" },
    ])
    expect((await db.sessions.get("s-test"))?.lastMessagePreview).toBe("[deleted]")
  })

  it("keeps both the row and preview withdrawn across concurrent edit and recall", async () => {
    await getDb().messages.put(
      makeStoredMessage({ id: "race", platformMessageId: "tg:race", platform: "telegram" })
    )
    await Promise.all([
      getBus().dispatchInboundFull(makeEditEvent("telegram", "tg:race", "late change")),
      getBus().dispatchInboundFull(makeDeleteEvent("telegram", "tg:race")),
    ])
    expect((await getDb().messages.get("race"))?.parts).toEqual([
      { type: "text", text: "[deleted]" },
    ])
    expect((await getDb().sessions.get("s-test"))?.lastMessagePreview).toBe("[deleted]")
  })
})
