/**
 * Tests for the TS-side attachment fetcher.
 *
 * We mock the Tauri command so the test runs in-process. Dexie writes use
 * fake-indexeddb against the real v38 schema.
 */

import "fake-indexeddb/auto"
import { fetchAttachment, pruneAttachmentsForAdapter, runLruEviction } from "./attachment-fetcher"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { connectorsAttachmentFetch } from "@/lib/connectors/tauri/commands"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  __esModule: true,
  connectorsAttachmentFetch: jest.fn(),
}))

const mockFetch = connectorsAttachmentFetch as jest.MockedFunction<typeof connectorsAttachmentFetch>

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  mockFetch.mockReset()
  mockFetch.mockResolvedValue({ localUrl: "file:///cache/abc", remoteRef: "rref" })
})

describe("fetchAttachment", () => {
  it("calls Rust on first fetch and persists a Dexie row", async () => {
    const result = await fetchAttachment({
      adapterId: "adp_1",
      remoteRef: "tg_file_xyz",
      sourceUrl: "https://t.me/files/xyz",
      mimeType: "image/png",
      sizeBytes: 1234,
    })
    expect(result.cached).toBe(false)
    expect(result.ref.localUrl).toBe("file:///cache/abc")
    expect(mockFetch).toHaveBeenCalledWith(
      "adp_1",
      "tg_file_xyz",
      "https://t.me/files/xyz",
      undefined
    )

    const row = await getDb().connectorAttachments.get("adp_1:tg_file_xyz")
    expect(row).toBeDefined()
    expect(row?.mimeType).toBe("image/png")
    expect(row?.sizeBytes).toBe(1234)
    expect(row?.localPath).toBe("file:///cache/abc")
    expect(row?.expiresAt).toBeGreaterThan(Date.now())
  })

  it("passes optional headers to Rust on cache miss", async () => {
    await fetchAttachment({
      adapterId: "mx-1",
      remoteRef: "mxc://matrix.org/abc",
      sourceUrl: "https://matrix.org/_matrix/client/v1/media/download/matrix.org/abc",
      headers: { Authorization: "Bearer tok" },
    })
    expect(mockFetch).toHaveBeenCalledWith(
      "mx-1",
      "mxc://matrix.org/abc",
      "https://matrix.org/_matrix/client/v1/media/download/matrix.org/abc",
      { Authorization: "Bearer tok" }
    )
  })

  it("returns cached row on second fetch within TTL (skips Rust)", async () => {
    await fetchAttachment({
      adapterId: "adp_1",
      remoteRef: "rref",
      sourceUrl: "https://x/y",
    })
    mockFetch.mockClear()

    const second = await fetchAttachment({
      adapterId: "adp_1",
      remoteRef: "rref",
      sourceUrl: "https://x/y",
    })
    expect(second.cached).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("refetches when row exists but has expired", async () => {
    await getDb().connectorAttachments.put({
      id: "adp_1:r1",
      adapterId: "adp_1",
      remoteRef: "r1",
      localPath: "file:///cache/old",
      mimeType: "application/pdf",
      sizeBytes: 0,
      fetchedAt: Date.now() - 1000,
      expiresAt: Date.now() - 500,
    })
    const r = await fetchAttachment({
      adapterId: "adp_1",
      remoteRef: "r1",
      sourceUrl: "https://x/y",
    })
    expect(r.cached).toBe(false)
    expect(mockFetch).toHaveBeenCalled()
  })

  it("supports ttlMs=0 (row never expires by TTL)", async () => {
    await fetchAttachment({
      adapterId: "adp_1",
      remoteRef: "perma",
      sourceUrl: "https://x/y",
      ttlMs: 0,
    })
    const row = await getDb().connectorAttachments.get("adp_1:perma")
    expect(row?.expiresAt).toBeUndefined()
  })
})

describe("pruneAttachmentsForAdapter", () => {
  it("deletes every row for the given adapter and leaves others alone", async () => {
    await getDb().connectorAttachments.bulkAdd([
      {
        id: "adp_1:a",
        adapterId: "adp_1",
        remoteRef: "a",
        localPath: "x",
        mimeType: "x",
        sizeBytes: 1,
        fetchedAt: 1,
      },
      {
        id: "adp_1:b",
        adapterId: "adp_1",
        remoteRef: "b",
        localPath: "x",
        mimeType: "x",
        sizeBytes: 1,
        fetchedAt: 1,
      },
      {
        id: "adp_2:c",
        adapterId: "adp_2",
        remoteRef: "c",
        localPath: "x",
        mimeType: "x",
        sizeBytes: 1,
        fetchedAt: 1,
      },
    ])
    const removed = await pruneAttachmentsForAdapter("adp_1")
    expect(removed).toBe(2)
    expect(await getDb().connectorAttachments.count()).toBe(1)
  })

  it("returns 0 when no rows match", async () => {
    expect(await pruneAttachmentsForAdapter("absent")).toBe(0)
  })
})

describe("runLruEviction", () => {
  it("keeps newest rows under the cap and deletes oldest overflow", async () => {
    const now = Date.now()
    await getDb().connectorAttachments.bulkAdd([
      {
        id: "adp_1:r1",
        adapterId: "adp_1",
        remoteRef: "r1",
        localPath: "x",
        mimeType: "x",
        sizeBytes: 300,
        fetchedAt: now - 3000,
      },
      {
        id: "adp_1:r2",
        adapterId: "adp_1",
        remoteRef: "r2",
        localPath: "x",
        mimeType: "x",
        sizeBytes: 300,
        fetchedAt: now - 2000,
      },
      {
        id: "adp_1:r3",
        adapterId: "adp_1",
        remoteRef: "r3",
        localPath: "x",
        mimeType: "x",
        sizeBytes: 300,
        fetchedAt: now - 1000,
      },
    ])
    // Cap = 500; newest 1 row (300) fits; second (600 total) exceeds cap → drop r1 + r2.
    // Walk reverse fetchedAt: r3 (300, under) → r2 (600, exceeds → drop) → r1 (900, exceeds → drop).
    const removed = await runLruEviction(500)
    expect(removed).toBe(2)
    const remaining = await getDb().connectorAttachments.toArray()
    expect(remaining.map((r) => r.remoteRef)).toEqual(["r3"])
  })

  it("is a no-op when total size is under cap", async () => {
    await getDb().connectorAttachments.put({
      id: "adp_1:r1",
      adapterId: "adp_1",
      remoteRef: "r1",
      localPath: "x",
      mimeType: "x",
      sizeBytes: 100,
      fetchedAt: Date.now(),
    })
    const removed = await runLruEviction(10_000)
    expect(removed).toBe(0)
    expect(await getDb().connectorAttachments.count()).toBe(1)
  })
})
