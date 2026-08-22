/** @jest-environment jsdom */
/**
 * Tests for the TS-side attachment fetcher.
 *
 * The Rust commands are mocked so the test runs in-process; Dexie writes go
 * through fake-indexeddb against the real schema.
 *
 * The behaviours pinned here are the ones that were previously wrong: sizes
 * must come from Rust (they used to default to 0, which made the LRU cap
 * unreachable), freshness must never be decided locally, and an index row may
 * only be dropped once Rust confirms its blob is gone.
 */

import "fake-indexeddb/auto"
import {
  computeCacheKey,
  enforceAttachmentBudget,
  fetchAttachment,
  pruneAttachmentsForAdapter,
  reconcileOrphanedAttachments,
  runCleanupLedger,
} from "./attachment-fetcher"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  connectorsAttachmentDelete,
  connectorsAttachmentEnforceBudget,
  connectorsAttachmentEvictAdapter,
  connectorsAttachmentFetch,
  connectorsAttachmentList,
} from "@/lib/connectors/tauri/commands"
import type { AttachmentCleanupReport } from "@/lib/connectors/tauri/commands"
import type { ConnectorAttachmentRow } from "@/lib/db/connector-types"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  __esModule: true,
  connectorsAttachmentFetch: jest.fn(),
  connectorsAttachmentList: jest.fn(),
  connectorsAttachmentDelete: jest.fn(),
  connectorsAttachmentEvictAdapter: jest.fn(),
  connectorsAttachmentEnforceBudget: jest.fn(),
}))

const mockFetch = connectorsAttachmentFetch as jest.MockedFunction<typeof connectorsAttachmentFetch>
const mockList = connectorsAttachmentList as jest.MockedFunction<typeof connectorsAttachmentList>
const mockDelete = connectorsAttachmentDelete as jest.MockedFunction<
  typeof connectorsAttachmentDelete
>
const mockEvict = connectorsAttachmentEvictAdapter as jest.MockedFunction<
  typeof connectorsAttachmentEvictAdapter
>
const mockBudget = connectorsAttachmentEnforceBudget as jest.MockedFunction<
  typeof connectorsAttachmentEnforceBudget
>

const EMPTY: AttachmentCleanupReport = { deleted: [], freedBytes: 0, failed: [] }

function ok(deleted: string[], freedBytes = 0): AttachmentCleanupReport {
  return { deleted, freedBytes, failed: [] }
}

async function seedRow(
  over: Partial<ConnectorAttachmentRow> = {}
): Promise<ConnectorAttachmentRow> {
  const adapterId = over.adapterId ?? "adp_1"
  const remoteRef = over.remoteRef ?? "rref"
  const row: ConnectorAttachmentRow = {
    id: `${adapterId}:${remoteRef}`,
    adapterId,
    remoteRef,
    cacheKey: over.cacheKey ?? (await computeCacheKey(adapterId, remoteRef)),
    mimeType: "image/png",
    sizeBytes: 10,
    fetchedAt: 1000,
    lastAccessedAt: 1000,
    ...over,
  }
  await getDb().connectorAttachments.put(row)
  return row
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  for (const m of [mockFetch, mockList, mockDelete, mockEvict, mockBudget]) m.mockReset()
  mockFetch.mockResolvedValue({
    cacheKey: "a".repeat(64),
    remoteRef: "rref",
    sizeBytes: 4096,
    createdAt: 1000,
    lastAccessedAt: 1000,
    expiresAt: 9999,
    cached: false,
  })
  mockList.mockResolvedValue([])
  mockDelete.mockResolvedValue(EMPTY)
  mockEvict.mockResolvedValue(EMPTY)
  mockBudget.mockResolvedValue(EMPTY)
})

describe("computeCacheKey", () => {
  it("matches the Rust cache key: hex sha256 of `adapterId:remoteRef`", async () => {
    // Cross-language fixture: SHA-256 of the literal bytes "adp_1:rref",
    // which is exactly what `compute_cache_key` hashes in
    // crates/cognia-connectors/src/attachments.rs. If these two ever diverge
    // the renderer deletes and reconciles keys that no file has.
    const key = await computeCacheKey("adp_1", "rref")
    expect(key).toBe("e89e5b68b3255334b1eb6dd2ab877cf27823a5b504c9831ae379d76b82e113b6")
    // Stable and input-sensitive.
    expect(await computeCacheKey("adp_1", "rref")).toBe(key)
    expect(await computeCacheKey("adp_2", "rref")).not.toBe(key)
    expect(await computeCacheKey("adp_1", "other")).not.toBe(key)
  })
})

describe("fetchAttachment", () => {
  it("persists the size, stamps and cache key Rust reported", async () => {
    const result = await fetchAttachment({
      adapterId: "adp_1",
      remoteRef: "tg_file_xyz",
      sourceUrl: "https://t.me/files/xyz",
      mimeType: "image/png",
    })

    expect(result.cached).toBe(false)
    const row = await getDb().connectorAttachments.get("adp_1:tg_file_xyz")
    expect(row?.mimeType).toBe("image/png")
    // The real byte count, not a caller hint and not a zero placeholder.
    expect(row?.sizeBytes).toBe(4096)
    expect(row?.cacheKey).toBe("a".repeat(64))
    expect(row?.fetchedAt).toBe(1000)
    expect(row?.lastAccessedAt).toBe(1000)
    expect(row?.expiresAt).toBe(9999)
  })

  it("always asks Rust, even when a live row exists — Rust owns freshness", async () => {
    await seedRow({ adapterId: "adp_1", remoteRef: "rref", expiresAt: Date.now() + 60_000 })
    mockFetch.mockResolvedValue({
      cacheKey: "b".repeat(64),
      remoteRef: "rref",
      sizeBytes: 8,
      createdAt: 2000,
      lastAccessedAt: 2500,
      expiresAt: undefined,
      cached: true,
    })

    const result = await fetchAttachment({
      adapterId: "adp_1",
      remoteRef: "rref",
      sourceUrl: "https://example.test/x",
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(result.cached).toBe(true)
    const row = await getDb().connectorAttachments.get("adp_1:rref")
    expect(row?.lastAccessedAt).toBe(2500)
    expect(row?.expiresAt).toBeUndefined()
  })

  it("forwards headers and the TTL override to Rust", async () => {
    await fetchAttachment({
      adapterId: "mx-1",
      remoteRef: "mxc://matrix.org/abc",
      sourceUrl: "https://matrix.org/download/abc",
      headers: { Authorization: "Bearer tok" },
      ttlMs: 0,
    })
    expect(mockFetch).toHaveBeenCalledWith(
      "mx-1",
      "mxc://matrix.org/abc",
      "https://matrix.org/download/abc",
      { Authorization: "Bearer tok" },
      0
    )
  })

  it("still stores the row when the budget sweep fails", async () => {
    mockBudget.mockRejectedValue(new Error("rust unavailable"))
    await expect(
      fetchAttachment({ adapterId: "adp_1", remoteRef: "r", sourceUrl: "https://x.test/a" })
    ).resolves.toBeDefined()
    expect(await getDb().connectorAttachments.get("adp_1:r")).toBeDefined()
  })
})

describe("enforceAttachmentBudget", () => {
  it("drops the rows whose blobs Rust evicted", async () => {
    const kept = await seedRow({ adapterId: "adp_1", remoteRef: "keep" })
    const evicted = await seedRow({ adapterId: "adp_1", remoteRef: "drop" })
    mockBudget.mockResolvedValue(ok([evicted.cacheKey], 4096))

    const report = await enforceAttachmentBudget(1024)
    expect(mockBudget).toHaveBeenCalledWith(1024)
    expect(report.freedBytes).toBe(4096)
    expect(await getDb().connectorAttachments.get(evicted.id)).toBeUndefined()
    expect(await getDb().connectorAttachments.get(kept.id)).toBeDefined()
  })

  it("ledgers a blob Rust could not delete instead of dropping its row", async () => {
    const stuck = await seedRow({ adapterId: "adp_1", remoteRef: "stuck" })
    mockBudget.mockResolvedValue({
      deleted: [],
      freedBytes: 0,
      failed: [{ cacheKey: stuck.cacheKey, error: "permission denied" }],
    })

    await enforceAttachmentBudget()

    // The row survives — dropping it is what orphaned ciphertext before.
    expect(await getDb().connectorAttachments.get(stuck.id)).toBeDefined()
    const job = await getDb().connectorCleanupJobs.get(stuck.cacheKey)
    expect(job?.lastError).toBe("permission denied")
    expect(job?.attempts).toBe(0)
  })
})

describe("pruneAttachmentsForAdapter", () => {
  it("deletes blobs first and drops only the confirmed rows", async () => {
    const a = await seedRow({ adapterId: "adp_1", remoteRef: "a" })
    const b = await seedRow({ adapterId: "adp_1", remoteRef: "b" })
    await seedRow({ adapterId: "adp_2", remoteRef: "c" })
    mockEvict.mockResolvedValue(ok([a.cacheKey, b.cacheKey], 20))

    const pruned = await pruneAttachmentsForAdapter("adp_1")

    expect(mockEvict).toHaveBeenCalledWith("adp_1")
    expect(pruned).toBe(2)
    expect(await getDb().connectorAttachments.get(a.id)).toBeUndefined()
    expect(await getDb().connectorAttachments.get(b.id)).toBeUndefined()
    expect(await getDb().connectorAttachments.get("adp_2:c")).toBeDefined()
  })

  it("falls back to a key-driven delete for blobs the adapter sweep missed", async () => {
    // Migrated legacy blobs carry no adapter provenance, so the hash-driven
    // eviction cannot find them.
    const legacy = await seedRow({ adapterId: "adp_1", remoteRef: "legacy" })
    mockEvict.mockResolvedValue(EMPTY)
    mockDelete.mockResolvedValue(ok([legacy.cacheKey], 10))

    const pruned = await pruneAttachmentsForAdapter("adp_1")

    expect(mockDelete).toHaveBeenCalledWith([legacy.cacheKey])
    expect(pruned).toBe(1)
    expect(await getDb().connectorAttachments.get(legacy.id)).toBeUndefined()
  })

  it("keeps the row and ledgers the job when neither pass confirms the delete", async () => {
    const stuck = await seedRow({ adapterId: "adp_1", remoteRef: "stuck" })
    mockEvict.mockResolvedValue(EMPTY)
    mockDelete.mockResolvedValue({
      deleted: [],
      freedBytes: 0,
      failed: [{ cacheKey: stuck.cacheKey, error: "file locked" }],
    })

    expect(await pruneAttachmentsForAdapter("adp_1")).toBe(0)
    expect(await getDb().connectorAttachments.get(stuck.id)).toBeDefined()
    const job = await getDb().connectorCleanupJobs.get(stuck.cacheKey)
    expect(job?.adapterId).toBe("adp_1")
    expect(job?.reason).toBe("adapter_removed")
  })

  it("derives the cache key for rows migrated without one", async () => {
    const row = await seedRow({ adapterId: "adp_1", remoteRef: "old", cacheKey: "" })
    const derived = await computeCacheKey("adp_1", "old")
    mockEvict.mockResolvedValue(EMPTY)
    mockDelete.mockResolvedValue(ok([derived]))

    expect(await pruneAttachmentsForAdapter("adp_1")).toBe(1)
    expect(mockDelete).toHaveBeenCalledWith([derived])
    expect(await getDb().connectorAttachments.get(row.id)).toBeUndefined()
  })
})

describe("reconcileOrphanedAttachments", () => {
  it("deletes blobs no row claims and leaves claimed ones alone", async () => {
    const claimed = await seedRow({ adapterId: "adp_1", remoteRef: "claimed" })
    const orphan = "f".repeat(64)
    mockList.mockResolvedValue([
      {
        cacheKey: claimed.cacheKey,
        sizeBytes: 10,
        createdAt: 1,
        lastAccessedAt: 1,
        diskBytes: 200,
      },
      { cacheKey: orphan, sizeBytes: 99, createdAt: 1, lastAccessedAt: 1, diskBytes: 300 },
    ])
    mockDelete.mockResolvedValue(ok([orphan], 99))

    const report = await reconcileOrphanedAttachments()
    expect(mockDelete).toHaveBeenCalledWith([orphan])
    expect(report.freedBytes).toBe(99)
    expect(await getDb().connectorAttachments.get(claimed.id)).toBeDefined()
  })

  it("recognises a row whose cache key was never backfilled", async () => {
    await seedRow({ adapterId: "adp_1", remoteRef: "old", cacheKey: "" })
    const derived = await computeCacheKey("adp_1", "old")
    mockList.mockResolvedValue([
      { cacheKey: derived, sizeBytes: 10, createdAt: 1, lastAccessedAt: 1, diskBytes: 200 },
    ])

    await reconcileOrphanedAttachments()
    // The blob is claimed by the un-backfilled row — deleting it would lose
    // an attachment the index still points at.
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it("skips the Rust call when there is nothing to delete", async () => {
    mockList.mockResolvedValue([])
    const report = await reconcileOrphanedAttachments()
    expect(mockDelete).not.toHaveBeenCalled()
    expect(report.deleted).toEqual([])
  })
})

describe("runCleanupLedger", () => {
  it("resolves jobs whose blob is finally gone and drops their rows", async () => {
    const row = await seedRow({ adapterId: "adp_1", remoteRef: "retry" })
    await getDb().connectorCleanupJobs.put({
      id: row.cacheKey,
      adapterId: "adp_1",
      reason: "adapter_removed",
      attempts: 2,
      nextAttemptAt: 500,
      createdAt: 1,
    })
    mockDelete.mockResolvedValue(ok([row.cacheKey], 10))

    const result = await runCleanupLedger(1000)
    expect(result).toEqual({ resolved: 1, stillFailing: 0 })
    expect(await getDb().connectorCleanupJobs.get(row.cacheKey)).toBeUndefined()
    expect(await getDb().connectorAttachments.get(row.id)).toBeUndefined()
  })

  it("backs a still-failing job off instead of forgetting it", async () => {
    const key = "c".repeat(64)
    await getDb().connectorCleanupJobs.put({
      id: key,
      adapterId: "adp_1",
      reason: "evicted",
      attempts: 0,
      nextAttemptAt: 500,
      createdAt: 1,
    })
    mockDelete.mockResolvedValue({
      deleted: [],
      freedBytes: 0,
      failed: [{ cacheKey: key, error: "still locked" }],
    })

    const result = await runCleanupLedger(1000)
    expect(result).toEqual({ resolved: 0, stillFailing: 1 })
    const job = await getDb().connectorCleanupJobs.get(key)
    expect(job?.attempts).toBe(1)
    expect(job?.nextAttemptAt).toBeGreaterThan(1000)
    expect(job?.lastError).toBe("still locked")
  })

  it("does not touch jobs whose backoff has not elapsed", async () => {
    await getDb().connectorCleanupJobs.put({
      id: "d".repeat(64),
      adapterId: "adp_1",
      reason: "evicted",
      attempts: 1,
      nextAttemptAt: 5_000,
      createdAt: 1,
    })
    const result = await runCleanupLedger(1000)
    expect(result).toEqual({ resolved: 0, stillFailing: 0 })
    expect(mockDelete).not.toHaveBeenCalled()
  })
})
