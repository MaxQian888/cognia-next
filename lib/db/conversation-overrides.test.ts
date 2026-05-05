/**
 * Tests for lib/db/conversation-overrides.ts — per-conversation settings CRUD.
 */

import "fake-indexeddb/auto"
import {
  upsertByConversationKey,
  readForResolution,
  setPinned,
  setArchived,
} from "./conversation-overrides"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function baseInput() {
  return {
    conversationKey: "telegram:adp_1:chat_123",
    sessionId: "sess_abc",
    mode: "auto" as const,
  }
}

describe("conversation-overrides", () => {
  it("upsertByConversationKey creates a new row", async () => {
    const row = await upsertByConversationKey(baseInput())
    expect(row.id).toMatch(/^cov_/)
    expect(row.conversationKey).toBe("telegram:adp_1:chat_123")
    expect(row.sessionId).toBe("sess_abc")
    expect(row.createdAt).toBeGreaterThan(0)
    expect(row.updatedAt).toBe(row.createdAt)
  })

  it("upsertByConversationKey is idempotent — same key returns same id", async () => {
    const first = await upsertByConversationKey(baseInput())
    const second = await upsertByConversationKey({ ...baseInput(), mode: "manual" })
    expect(second.id).toBe(first.id)
    expect(second.mode).toBe("manual")
  })

  it("upsertByConversationKey bumps updatedAt on re-upsert", async () => {
    const first = await upsertByConversationKey(baseInput())
    await new Promise((r) => setTimeout(r, 2))
    const second = await upsertByConversationKey(baseInput())
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
  })

  it("readForResolution returns the row for a key", async () => {
    await upsertByConversationKey(baseInput())
    const found = await readForResolution("telegram:adp_1:chat_123")
    expect(found).toBeDefined()
    expect(found?.conversationKey).toBe("telegram:adp_1:chat_123")
  })

  it("readForResolution returns undefined for unknown key", async () => {
    expect(await readForResolution("unknown:key")).toBeUndefined()
  })

  it("setPinned sets pinned=true and bumps updatedAt", async () => {
    const row = await upsertByConversationKey(baseInput())
    await new Promise((r) => setTimeout(r, 2))
    await setPinned(row.id, true)
    const updated = await getDb().conversationOverrides.get(row.id)
    expect(updated?.pinned).toBe(true)
    expect(updated?.updatedAt).toBeGreaterThan(row.updatedAt)
  })

  it("setPinned sets pinned=false (unpin)", async () => {
    const row = await upsertByConversationKey(baseInput())
    await setPinned(row.id, true)
    await setPinned(row.id, false)
    const updated = await getDb().conversationOverrides.get(row.id)
    expect(updated?.pinned).toBe(false)
  })

  it("setArchived sets archived=true", async () => {
    const row = await upsertByConversationKey(baseInput())
    await setArchived(row.id, true)
    const updated = await getDb().conversationOverrides.get(row.id)
    expect(updated?.archived).toBe(true)
  })

  it("setArchived sets archived=false", async () => {
    const row = await upsertByConversationKey(baseInput())
    await setArchived(row.id, true)
    await setArchived(row.id, false)
    const updated = await getDb().conversationOverrides.get(row.id)
    expect(updated?.archived).toBe(false)
  })

  it("optional fields (characterId, trigger, lastReadAt) round-trip", async () => {
    const row = await upsertByConversationKey({
      ...baseInput(),
      characterId: "char_1",
      lastReadAt: 12345,
    })
    expect(row.characterId).toBe("char_1")
    expect(row.lastReadAt).toBe(12345)
  })
})
