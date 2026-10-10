// Pure ADR-0222 blob rules and the read-ticket format. `ticket-vector.json`
// is the same frozen vector `core/src/ticket.rs` mints, so a format change
// fails both sides.

import { describe, expect, it } from "vitest"
import vector from "../../ticket-vector.json"
import {
  BLOB_ID_LENGTH,
  MAX_CHUNKS_PER_BLOB,
  MAX_CHUNK_CIPHERTEXT_BYTES,
  blobPrefix,
  chunkKey,
  importTicketKey,
  isStorageSafeCode,
  isValidBlobId,
  mintTicket,
  parseChunkIndex,
  ticketExpiry,
  validateCommit,
  verifyTicket,
} from "./blobs"

const FULL = MAX_CHUNK_CIPHERTEXT_BYTES

describe("limits", () => {
  it("derives the same shape as the Rust core", () => {
    expect(MAX_CHUNKS_PER_BLOB).toBe(128)
    expect(MAX_CHUNK_CIPHERTEXT_BYTES).toBe(4 * 1024 * 1024 + 16)
    expect(BLOB_ID_LENGTH).toBe(22)
  })
})

describe("path validation", () => {
  it("accepts only exact base64url blob ids", () => {
    expect(isValidBlobId("AAAAAAAAAAAAAAAAAAAA-_")).toBe(true)
    expect(isValidBlobId("AAAAAAAAAAAAAAAAAAAA-")).toBe(false)
    expect(isValidBlobId("AAAAAAAAAAAAAAAAAAAA/_")).toBe(false)
    expect(isValidBlobId("../AAAAAAAAAAAAAAAAAAA")).toBe(false)
  })

  it("accepts only alphanumeric codes", () => {
    expect(isStorageSafeCode("Abc123XYZ789")).toBe(true)
    expect(isStorageSafeCode("abc/def")).toBe(false)
    expect(isStorageSafeCode("")).toBe(false)
    expect(isStorageSafeCode("a".repeat(65))).toBe(false)
  })

  it("parses canonical, bounded chunk indexes", () => {
    expect(parseChunkIndex("0")).toBe(0)
    expect(parseChunkIndex("127")).toBe(127)
    for (const bad of ["128", "01", "-1", "+1", "", "1e2", "99999999999"]) {
      expect(parseChunkIndex(bad)).toBeNull()
    }
  })

  it("keys chunks under the share's blob prefix", () => {
    expect(blobPrefix("CODE")).toBe("share/CODE/blob/")
    expect(chunkKey("CODE", "B", 3)).toBe("share/CODE/blob/B/3")
  })
})

describe("validateCommit", () => {
  it("accepts full chunks and a short last one", () => {
    expect(validateCommit(2, FULL + 116, { "0": FULL, "1": 116 })).toBeNull()
    expect(validateCommit(1, 17, { "0": 17 })).toBeNull()
  })

  it("refuses gaps, wrong totals, short middles and bad counts", () => {
    expect(validateCommit(0, 0, {})).toBe("bad-chunk-count")
    expect(validateCommit(129, 0, {})).toBe("bad-chunk-count")
    expect(validateCommit(2, FULL, { "0": FULL })).toBe("missing-chunks")
    expect(validateCommit(2, FULL + 20, { "0": FULL, "2": 20 })).toBe("missing-chunks")
    expect(validateCommit(2, 40, { "0": 20, "1": 20 })).toBe("bad-chunk-shape")
    expect(validateCommit(1, 16, { "0": 16 })).toBe("bad-chunk-shape")
    expect(validateCommit(1, 99, { "0": 20 })).toBe("size-mismatch")
  })
})

describe("read tickets", () => {
  it("matches the frozen vector the Rust core also mints", async () => {
    const key = await importTicketKey(vector.keyHex)
    expect(key).not.toBeNull()
    expect(await mintTicket(key!, vector.code, vector.expiresAt)).toBe(vector.ticket)
  })

  it("opens its own share until it expires", async () => {
    const key = (await importTicketKey(vector.keyHex))!
    const ticket = await mintTicket(key, "CODE12345678", 10_000)
    expect(await verifyTicket(key, ticket, "CODE12345678", 9_999)).toBe(true)
    expect(await verifyTicket(key, ticket, "CODE12345678", 10_000)).toBe(false)
    expect(await verifyTicket(key, ticket, "OTHER1234567", 9_999)).toBe(false)
  })

  it("cannot be extended, forged or garbled", async () => {
    const key = (await importTicketKey(vector.keyHex))!
    const ticket = await mintTicket(key, "CODE12345678", 10_000)
    const signature = ticket.slice(ticket.indexOf(".") + 1)
    expect(await verifyTicket(key, `99999999.${signature}`, "CODE12345678", 0)).toBe(false)
    const other = (await importTicketKey("ff".repeat(32)))!
    expect(await verifyTicket(other, ticket, "CODE12345678", 0)).toBe(false)
    for (const junk of ["", ".", "10000", "10000.", "-1.abc", "1e5.abc", "10000.!!!"]) {
      expect(await verifyTicket(key, junk, "CODE12345678", 0)).toBe(false)
    }
  })

  it("refuses a missing or short key", async () => {
    expect(await importTicketKey(undefined)).toBeNull()
    expect(await importTicketKey("")).toBeNull()
    expect(await importTicketKey("ab".repeat(8))).toBeNull()
    expect(await importTicketKey("zz".repeat(32))).toBeNull()
  })

  it("never outlives the share", () => {
    expect(ticketExpiry(1_000, undefined)).toBe(3_601_000)
    expect(ticketExpiry(1_000, 5_000)).toBe(5_000)
  })
})
