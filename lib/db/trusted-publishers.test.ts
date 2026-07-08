/** @jest-environment jsdom */
/**
 * Tests for the trusted publishers Dexie helper.
 */

import "fake-indexeddb/auto"

import {
  trustPublisher,
  getTrustedPublisher,
  isPublisherTrusted,
  listTrustedPublishers,
  revokePublisher,
} from "./trusted-publishers"
import { getDb } from "./schema"

beforeEach(async () => {
  const db = getDb()
  await db.trustedPublishers.clear()
})

describe("trustPublisher", () => {
  it("creates a fresh row on first trust", async () => {
    const row = await trustPublisher({
      publicKey: "AAA=",
      fingerprint: "9f3a",
      authorName: "Alice",
    })
    expect(row.publicKey).toBe("AAA=")
    expect(row.fingerprint).toBe("9f3a")
    expect(row.authorName).toBe("Alice")
    expect(row.installCount).toBe(1)
    expect(row.firstTrustedAt).toBeGreaterThan(0)
    expect(row.lastSeenAt).toBe(row.firstTrustedAt)
  })

  it("preserves firstTrustedAt and bumps installCount on re-trust", async () => {
    const first = await trustPublisher({ publicKey: "AAA=", fingerprint: "9f3a" })
    await new Promise((r) => setTimeout(r, 5))
    const second = await trustPublisher({
      publicKey: "AAA=",
      fingerprint: "9f3a",
      authorName: "Alice",
    })
    expect(second.firstTrustedAt).toBe(first.firstTrustedAt)
    expect(second.lastSeenAt).toBeGreaterThanOrEqual(first.lastSeenAt)
    expect(second.installCount).toBe(2)
    expect(second.authorName).toBe("Alice")
  })
})

describe("isPublisherTrusted", () => {
  it("returns false for unknown keys", async () => {
    expect(await isPublisherTrusted("AAA=")).toBe(false)
  })

  it("returns false for empty keys", async () => {
    expect(await isPublisherTrusted("")).toBe(false)
  })

  it("returns true after trustPublisher", async () => {
    await trustPublisher({ publicKey: "AAA=", fingerprint: "9f3a" })
    expect(await isPublisherTrusted("AAA=")).toBe(true)
  })
})

describe("listTrustedPublishers", () => {
  it("returns rows sorted newest-first by firstTrustedAt", async () => {
    await trustPublisher({ publicKey: "K1=", fingerprint: "11" })
    await new Promise((r) => setTimeout(r, 5))
    await trustPublisher({ publicKey: "K2=", fingerprint: "22" })
    await new Promise((r) => setTimeout(r, 5))
    await trustPublisher({ publicKey: "K3=", fingerprint: "33" })
    const list = await listTrustedPublishers()
    expect(list.map((r) => r.publicKey)).toEqual(["K3=", "K2=", "K1="])
  })

  it("returns an empty list when no rows", async () => {
    expect(await listTrustedPublishers()).toEqual([])
  })
})

describe("revokePublisher", () => {
  it("removes the row so future trust checks fail", async () => {
    await trustPublisher({ publicKey: "AAA=", fingerprint: "9f3a" })
    await revokePublisher("AAA=")
    expect(await getTrustedPublisher("AAA=")).toBeUndefined()
    expect(await isPublisherTrusted("AAA=")).toBe(false)
  })

  it("is a no-op when the key is not present", async () => {
    await expect(revokePublisher("ghost")).resolves.toBeUndefined()
  })
})
