/**
 * Tests for lib/db/platform-identities.ts — CRUD for platformIdentities table.
 */

import {
  upsertIdentity,
  mergeIdentities,
  unmergeIdentity,
  listMergedGroups,
  listByAdapter,
  getByPlatformUser,
  listMergeCandidates,
} from "./platform-identities"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

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
    const result = await mergeIdentities(primary.id, secondary.id)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.primary.id).toBe(primary.id)
    expect(result.primary.mergedFromIds).toContain(secondary.id)
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
    const result = await mergeIdentities(primary.id, sec2.id)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.primary.mergedFromIds).toContain(sec1.id)
    expect(result.primary.mergedFromIds).toContain(sec2.id)
  })

  it("mergeIdentities returns a typed outcome if primary does not exist", async () => {
    const secondary = await upsertIdentity(baseInput())
    await expect(mergeIdentities("nope", secondary.id)).resolves.toEqual({
      ok: false,
      reason: "primary_missing",
    })
  })

  it("mergeIdentities snapshots the secondary for lossless unmerge", async () => {
    const primary = await upsertIdentity({ ...baseInput(), remoteUserId: "p" })
    const secondary = await upsertIdentity({
      platform: "discord",
      adapterId: "adp_2",
      remoteUserId: "s",
      displayName: "Alice on Discord",
    })
    const result = await mergeIdentities(primary.id, secondary.id)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.primary.mergedSnapshots).toHaveLength(1)
    expect(result.primary.mergedSnapshots?.[0]).toMatchObject({
      id: secondary.id,
      platform: "discord",
    })
  })

  it("unmergeIdentity restores the secondary exactly and cleans the primary", async () => {
    const primary = await upsertIdentity({ ...baseInput(), remoteUserId: "p" })
    const secondary = await upsertIdentity({
      platform: "discord",
      adapterId: "adp_2",
      remoteUserId: "s",
      displayName: "Alice on Discord",
      avatarUrl: "https://x/d.png",
    })
    await mergeIdentities(primary.id, secondary.id)

    const restored = await unmergeIdentity(primary.id, secondary.id)
    expect(restored).toMatchObject({
      ok: true,
      restored: { id: secondary.id, displayName: "Alice on Discord" },
    })

    const reloadedSecondary = await getDb().platformIdentities.get(secondary.id)
    expect(reloadedSecondary).toMatchObject({ platform: "discord", avatarUrl: "https://x/d.png" })
    const reloadedPrimary = await getDb().platformIdentities.get(primary.id)
    expect(reloadedPrimary?.mergedFromIds).not.toContain(secondary.id)
    expect(reloadedPrimary?.mergedSnapshots ?? []).toHaveLength(0)
  })

  it("unmergeIdentity returns typed stale outcomes", async () => {
    const primary = await upsertIdentity(baseInput())
    expect(await unmergeIdentity("nope", "x")).toEqual({
      ok: false,
      reason: "primary_missing",
    })
    expect(await unmergeIdentity(primary.id, "never-merged")).toEqual({
      ok: false,
      reason: "snapshot_missing",
    })
  })

  it("listMergedGroups groups primaries with their absorbed identities", async () => {
    const primary = await upsertIdentity({ ...baseInput(), remoteUserId: "p" })
    const secondary = await upsertIdentity({
      platform: "discord",
      adapterId: "adp_2",
      remoteUserId: "s",
    })
    const solo = await upsertIdentity({ platform: "slack", adapterId: "adp_3", remoteUserId: "z" })
    await mergeIdentities(primary.id, secondary.id)

    const groups = await listMergedGroups()
    const merged = groups.find((g) => g.primary.id === primary.id)
    const lone = groups.find((g) => g.primary.id === solo.id)
    expect(merged?.merged.map((m) => m.id)).toEqual([secondary.id])
    expect(lone?.merged).toEqual([])
  })

  it("resolves inbound traffic for an absorbed identity to the primary and updates its snapshot", async () => {
    const primary = await upsertIdentity({ ...baseInput(), remoteUserId: "p" })
    const secondary = await upsertIdentity({
      platform: "discord",
      adapterId: "d1",
      remoteUserId: "s",
      displayName: "Old name",
    })
    expect((await mergeIdentities(primary.id, secondary.id)).ok).toBe(true)

    const resolved = await upsertIdentity({
      platform: "discord",
      adapterId: "d2",
      remoteUserId: "s",
      displayName: "Fresh name",
    })

    expect(resolved.id).toBe(primary.id)
    expect(resolved.mergedSnapshots?.[0]).toMatchObject({
      id: secondary.id,
      adapterId: "d2",
      displayName: "Fresh name",
    })
    expect(await getByPlatformUser("discord", "s")).toMatchObject({ id: primary.id })
    expect(await getDb().platformIdentities.count()).toBe(1)

    const unmerged = await unmergeIdentity(primary.id, secondary.id)
    expect(unmerged).toMatchObject({ ok: true, restored: { displayName: "Fresh name" } })
  })

  it("preserves nested merge history through merge and unmerge", async () => {
    const primary = await upsertIdentity({ ...baseInput(), remoteUserId: "p" })
    const secondary = await upsertIdentity({
      platform: "discord",
      adapterId: "d1",
      remoteUserId: "s",
    })
    const nested = await upsertIdentity({
      platform: "slack",
      adapterId: "sl1",
      remoteUserId: "nested",
    })
    expect((await mergeIdentities(secondary.id, nested.id)).ok).toBe(true)
    const merged = await mergeIdentities(primary.id, secondary.id)
    expect(merged).toMatchObject({
      ok: true,
      primary: { mergedFromIds: expect.arrayContaining([secondary.id, nested.id]) },
    })

    await upsertIdentity({
      platform: "slack",
      adapterId: "sl2",
      remoteUserId: "nested",
      displayName: "Nested updated",
    })
    const unmerged = await unmergeIdentity(primary.id, secondary.id)
    expect(unmerged).toMatchObject({ ok: true })
    expect(await getByPlatformUser("slack", "nested")).toMatchObject({
      id: secondary.id,
      mergedSnapshots: [expect.objectContaining({ displayName: "Nested updated" })],
    })
  })

  it("rejects self merge, missing secondary, and already-absorbed identities", async () => {
    const primary = await upsertIdentity({ ...baseInput(), remoteUserId: "p" })
    const secondary = await upsertIdentity({ ...baseInput(), remoteUserId: "s" })
    expect(await mergeIdentities(primary.id, primary.id)).toEqual({
      ok: false,
      reason: "same_identity",
    })
    expect(await mergeIdentities(primary.id, "missing")).toEqual({
      ok: false,
      reason: "secondary_missing",
    })
    expect((await mergeIdentities(primary.id, secondary.id)).ok).toBe(true)
    expect(await mergeIdentities(primary.id, secondary.id)).toEqual({
      ok: false,
      reason: "secondary_absorbed",
    })
  })

  it("does not restore an alias whose compound identity was concurrently claimed", async () => {
    const primary = await upsertIdentity({ ...baseInput(), remoteUserId: "p" })
    const secondary = await upsertIdentity({
      platform: "discord",
      adapterId: "d1",
      remoteUserId: "s",
    })
    expect((await mergeIdentities(primary.id, secondary.id)).ok).toBe(true)
    await getDb().platformIdentities.add({
      ...secondary,
      id: "conflicting-row",
      mergedFromIds: [],
    })

    expect(await unmergeIdentity(primary.id, secondary.id)).toEqual({
      ok: false,
      reason: "identity_conflict",
    })
    expect(await getDb().platformIdentities.get(primary.id)).toMatchObject({
      mergedFromIds: expect.arrayContaining([secondary.id]),
    })
  })

  it("lists only top-level non-conflicting merge candidates", async () => {
    const primary = await upsertIdentity({ ...baseInput(), remoteUserId: "p" })
    const candidate = await upsertIdentity({
      platform: "discord",
      adapterId: "d1",
      remoteUserId: "candidate",
    })
    const absorbed = await upsertIdentity({
      platform: "slack",
      adapterId: "s1",
      remoteUserId: "absorbed",
    })
    expect((await mergeIdentities(candidate.id, absorbed.id)).ok).toBe(true)
    expect((await listMergeCandidates(primary.id)).map((identity) => identity.id)).toEqual([
      candidate.id,
    ])
  })
})
