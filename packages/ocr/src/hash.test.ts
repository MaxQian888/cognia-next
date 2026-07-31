/** @jest-environment jsdom */

import { sha256Blob, sha256Bytes, sha256DataUrl, sha256String } from "./hash"

describe("sha256String", () => {
  it("matches the canonical empty-string digest", async () => {
    expect(await sha256String("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  })

  it("matches a known reference for 'abc'", async () => {
    expect(await sha256String("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })

  it("is deterministic across calls", async () => {
    expect(await sha256String("cognia")).toBe(await sha256String("cognia"))
  })
})

describe("sha256Bytes", () => {
  it("accepts Uint8Array and ArrayBuffer interchangeably", async () => {
    const bytes = new TextEncoder().encode("abc")
    const fromArr = await sha256Bytes(bytes)
    const fromBuf = await sha256Bytes(bytes.buffer.slice(0))
    expect(fromArr).toBe(fromBuf)
    expect(fromArr).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  it("respects byteOffset on subarrays", async () => {
    const full = new Uint8Array([0x00, 0x61, 0x62, 0x63])
    const slice = new Uint8Array(full.buffer, 1, 3)
    expect(await sha256Bytes(slice)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })
})

describe("sha256Blob", () => {
  it("hashes the underlying bytes", async () => {
    const blob = new Blob(["abc"])
    expect(await sha256Blob(blob)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })
})

describe("sha256DataUrl", () => {
  it("hashes the decoded payload", async () => {
    // "abc" -> base64 "YWJj"
    const dataUrl = "data:image/png;base64,YWJj"
    expect(await sha256DataUrl(dataUrl)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })

  it("returns null for non-data-url input", async () => {
    expect(await sha256DataUrl("not-a-data-url")).toBeNull()
    expect(await sha256DataUrl("https://example.com/x.png")).toBeNull()
  })
})
