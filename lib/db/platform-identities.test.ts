/**
 * Tests for lib/db/platform-identities.ts — CRUD for platformIdentities table.
 */

import "fake-indexeddb/auto"
import {
  upsertIdentity,
  mergeIdentities,
  listByAdapter,
  getByPlatformUser,
} from "./platform-identities"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function baseInput() {
  return {
    platform: "telegram" as const,
    adapterId: "adp_1",
    remoteUserId: "user_123",
    displayName: "Alice",
    avatarUrl: "https://example.com/avatar.jpg",
  }
}

describe("platform-identities", () => {
  it("upsertIdentity creates a new row and returns it", async () => {
    const row = await upsertIdentity(baseInput())
    expect(row.id).toMatch(/^pid_/)
    expect(row.platform).toBe("telegram")
    expect(row.remoteUserId).toBe("user_123")
    expect(row.lastSeenAt).toBeGreaterThan(0)
  })

  it("upsertIdentity is idempotent on [platform+remoteUserId]", async () => {
    const first = await upsertIdentity(baseInput())
    const second = await upsertIdentity({ ...baseInput(), displayName: "Alice Updated" })
    expect(second.id).toBe(first.id)
    expect(second.displayName).toBe("Alice Updated")
  })

  it("upsertIdentity bumps lastSeenAt on re-upsert", async () => {
    const first = await upsertIdentity(baseInput())
    await new Promise((r) => setTimeout(r, 2))
    const second = await upsertIdentity(baseInput())
    expect(second.lastSeenAt).toBeGreaterThanOrEqual(first.lastSeenAt)
  })

  it("getByPlatformUser returns the row after upsert", async () => {
    await upsertIdentity(baseInput())
    const found = await getByPlatformUser("telegram", "user_123")
    expect(found).toBeDefined()
    expect(found?.remoteUserId).toBe("user_123")
  })

  it("getByPlatformUser returns undefined for unknown user", async () => {
    expect(await getByPlatformUser("telegram", "unknown")).toBeUndefined()
  })

  it("listByAdapter returns rows for adapter, newest-first", async () => {
    await upsertIdentity({ ...baseInput(), remoteUserId: "u1" })
    await new Promise((r) => setTimeout(r, 2))
    await upsertIdentity({ ...baseInput(), remoteUserId: "u2" })
    const rows = await listByAdapter("adp_1")
    expect(rows).toHaveLength(2)
    // newest lastSeenAt first
    expect(rows[0].remoteUserId).toBe("u2")
  })

  it("listByAdapter returns empty array for unknown adapter", async () => {
    expect(await listByAdapter("adp_unknown")).toEqual([])
  })

  it("mergeIdentities moves secondaryId into primary.mergedFromIds and deletes secondary", async () => {
    const primary = await upsertIdentity({ ...baseInput(), remoteUserId: "primary_user" })
    const secondary = await upsertIdentity({
      ...baseInput(),
      remoteUserId: "secondary_user",
    })
    const merged = await mergeIdentities(primary.id, secondary.id)
    expect(merged.id).toBe(primary.id)
    expect(merged.mergedFromIds).toContain(secondary.id)
    // secondary row should be deleted
    const db = getDb()
    const secondaryRow = await db.platformIdentities.get(secondary.id)
    expect(secondaryRow).toBeUndefined()
  })

  it("mergeIdentities appends to existing mergedFromIds", async () => {
    const primary = await upsertIdentity({ ...baseInput(), remoteUserId: "primary_user" })
    const sec1 = await upsertIdentity({ ...baseInput(), remoteUserId: "sec1" })
    const sec2 = await upsertIdentity({ ...baseInput(), remoteUserId: "sec2" })
    await mergeIdentities(primary.id, sec1.id)
    const merged = await mergeIdentities(primary.id, sec2.id)
    expect(merged.mergedFromIds).toContain(sec1.id)
    expect(merged.mergedFromIds).toContain(sec2.id)
  })

  it("mergeIdentities throws if primary does not exist", async () => {
    const secondary = await upsertIdentity(baseInput())
    await expect(mergeIdentities("nope", secondary.id)).rejects.toThrow()
  })
})
