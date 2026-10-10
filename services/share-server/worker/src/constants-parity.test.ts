// Constants-parity gate against the committed canonical fixture
// ../../share-constants.json (ADR-0059 P0.3). The Rust twin lives at
// tests/constants_parity.rs — drift on either side fails that side's CI.

import { describe, expect, it } from "vitest"
import fixture from "../../share-constants.json"
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_TTL_SECONDS,
  KV_MIN_TTL_SECONDS,
  PUBLIC_METADATA_SUFFIX,
  PUBLIC_METADATA_FIELDS,
} from "./index"
import {
  BLOB_CHUNK_BYTES,
  BLOB_CHUNK_OVERHEAD_BYTES,
  BLOB_ID_BYTES,
  MAX_BLOBS_PER_SHARE,
  MAX_BLOB_BYTES,
  MAX_SHARE_BLOB_BYTES,
  READ_TICKET_TTL_SECONDS,
} from "./blobs"

describe("share constants parity (share-constants.json)", () => {
  it("public metadata endpoint and fields match the fixture", () => {
    expect(PUBLIC_METADATA_SUFFIX).toBe(fixture.publicMetadataSuffix)
    expect(PUBLIC_METADATA_FIELDS).toEqual(fixture.publicMetadataFields)
  })
  it("code length matches the fixture", () => {
    expect(CODE_LENGTH).toBe(fixture.codeLength)
  })

  it("code alphabet matches the fixture", () => {
    expect(CODE_ALPHABET).toBe(fixture.codeAlphabet)
  })

  it("default max body bytes matches the fixture", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(fixture.defaultMaxBodyBytes)
  })

  it("default max TTL seconds matches the fixture", () => {
    expect(DEFAULT_MAX_TTL_SECONDS).toBe(fixture.defaultMaxTtlSeconds)
  })

  it("KV minimum TTL matches the fixture (Worker-only constraint)", () => {
    expect(KV_MIN_TTL_SECONDS).toBe(fixture.kvMinTtlSeconds)
  })

  it("ADR-0222 blob limits match the fixture", () => {
    expect(BLOB_CHUNK_BYTES).toBe(fixture.blobChunkBytes)
    expect(BLOB_CHUNK_OVERHEAD_BYTES).toBe(fixture.blobChunkOverheadBytes)
    expect(BLOB_ID_BYTES).toBe(fixture.blobIdBytes)
    expect(MAX_BLOB_BYTES).toBe(fixture.maxBlobBytes)
    expect(MAX_SHARE_BLOB_BYTES).toBe(fixture.maxShareBlobBytes)
    expect(MAX_BLOBS_PER_SHARE).toBe(fixture.maxBlobsPerShare)
    expect(READ_TICKET_TTL_SECONDS).toBe(fixture.readTicketTtlSeconds)
  })
})
