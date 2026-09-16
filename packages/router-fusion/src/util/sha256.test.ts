import { createHash, createHmac } from "node:crypto"

import { z } from "zod"

import { canonicalHash, canonicalJson, hmacSha256Hex, sha256Hex, uuidFromName } from "./sha256"

describe("sha256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("matches the NIST vector for %j", (input, expected) => {
    expect(sha256Hex(input)).toBe(expected)
  })

  it("agrees with node:crypto across block boundaries and multibyte text", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const text = "é".repeat(length) + "a".repeat(length % 7)
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"))
    }
  })

  it("computes RFC 2104 HMAC including long keys", () => {
    for (const key of ["k", "tenant-1", "x".repeat(100)]) {
      expect(hmacSha256Hex(key, "payload 中文")).toBe(
        createHmac("sha256", key).update("payload 中文").digest("hex")
      )
    }
  })
})

describe("canonical JSON", () => {
  it("sorts keys recursively and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}'
    )
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }))
  })

  it("preserves whitespace inside strings", () => {
    expect(canonicalHash({ content: "hello  world" })).not.toBe(
      canonicalHash({ content: "hello world" })
    )
  })

  it("refuses values JSON cannot represent faithfully", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
    expect(() => canonicalJson(undefined)).toThrow(TypeError)
    expect(canonicalJson([undefined])).toBe("[null]")
  })
})

describe("uuidFromName", () => {
  it("is a stable version 8 UUID the contracts accept", () => {
    const id = uuidFromName("run-1:runs/run-1/answer:abc")
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(uuidFromName("run-1:runs/run-1/answer:abc")).toBe(id)
    expect(z.uuid().safeParse(id).success).toBe(true)
  })

  it("gives different names different ids", () => {
    expect(uuidFromName("a")).not.toBe(uuidFromName("b"))
    expect(uuidFromName("")).not.toBe(uuidFromName(" "))
  })
})
