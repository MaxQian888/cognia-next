/**
 * Tests for lib/db/connector-attachments.ts — cached platform attachment CRUD.
 */

import "fake-indexeddb/auto"
import { upsertAttachment, findByRemoteRef, cleanupExpired } from "./connector-attachments"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import type { ConnectorAttachmentRow } from "./connector-types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeRow(overrides: Partial<ConnectorAttachmentRow> = {}): ConnectorAttachmentRow {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    adapterId: overrides.adapterId ?? "adp_1",
    remoteRef: overrides.remoteRef ?? "file_abc123",
    localPath: overrides.localPath ?? "/cache/abc123",
    mimeType: overrides.mimeType ?? "image/jpeg",
    sizeBytes: overrides.sizeBytes ?? 1024,
    fetchedAt: overrides.fetchedAt ?? Date.now(),
    expiresAt: overrides.expiresAt,
  }
}

describe("connector-attachments", () => {
  it("upsertAttachment creates a new row and returns it", async () => {
    const row = makeRow()
    const result = await upsertAttachment(row)
    expect(result.id).toBe(row.id)
    expect(result.adapterId).toBe("adp_1")
    expect(result.remoteRef).toBe("file_abc123")
    expect(result.mimeType).toBe("image/jpeg")
  })

  it("upsertAttachment replaces existing row keyed by [adapterId+remoteRef]", async () => {
    const original = makeRow({ localPath: "/cache/original" })
    await upsertAttachment(original)
    const updated = makeRow({ localPath: "/cache/updated", fetchedAt: Date.now() + 1000 })
    const result = await upsertAttachment(updated)
    expect(result.localPath).toBe("/cache/updated")
    // Should only have one row for this [adapterId+remoteRef]
    const count = await getDb().connectorAttachments.count()
    expect(count).toBe(1)
  })

  it("upsertAttachment treats same remoteRef on different adapters as distinct rows", async () => {
    await upsertAttachment(makeRow({ adapterId: "adp_1", remoteRef: "file_shared" }))
    await upsertAttachment(makeRow({ adapterId: "adp_2", remoteRef: "file_shared" }))
    expect(await getDb().connectorAttachments.count()).toBe(2)
  })

  it("findByRemoteRef returns the row after upsert", async () => {
    const row = makeRow()
    await upsertAttachment(row)
    const found = await findByRemoteRef("adp_1", "file_abc123")
    expect(found).toBeDefined()
    expect(found?.localPath).toBe("/cache/abc123")
  })

  it("findByRemoteRef returns undefined for unknown ref", async () => {
    expect(await findByRemoteRef("adp_1", "unknown_ref")).toBeUndefined()
  })

  it("findByRemoteRef is scoped to adapter — different adapter returns undefined", async () => {
    await upsertAttachment(makeRow({ adapterId: "adp_1", remoteRef: "file_xyz" }))
    expect(await findByRemoteRef("adp_2", "file_xyz")).toBeUndefined()
  })

  it("cleanupExpired deletes rows where expiresAt < now and returns count", async () => {
    const past = Date.now() - 1000
    const future = Date.now() + 60_000
    await upsertAttachment(makeRow({ id: "r1", expiresAt: past }))
    await upsertAttachment(makeRow({ id: "r2", remoteRef: "file_2", expiresAt: future }))
    await upsertAttachment(makeRow({ id: "r3", remoteRef: "file_3" })) // no expiresAt
    const count = await cleanupExpired()
    expect(count).toBe(1)
    expect(await getDb().connectorAttachments.count()).toBe(2)
  })

  it("cleanupExpired returns 0 when nothing has expired", async () => {
    await upsertAttachment(makeRow())
    expect(await cleanupExpired()).toBe(0)
  })

  it("cleanupExpired uses provided `now` timestamp", async () => {
    const futureExpiry = Date.now() + 5000
    await upsertAttachment(makeRow({ expiresAt: futureExpiry }))
    // Pass a now that is after expiresAt
    const count = await cleanupExpired(futureExpiry + 1)
    expect(count).toBe(1)
  })
})
