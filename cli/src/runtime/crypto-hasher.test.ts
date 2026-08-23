/**
 * @jest-environment node
 */
import { createHash } from "node:crypto"

import { createRuntimeHasher, hashHex, type RuntimeHasher } from "./crypto-hasher"

describe("createRuntimeHasher", () => {
  it("uses a callable Bun CryptoHasher capability", () => {
    const algorithms: string[] = []
    const updates: Array<string | Uint8Array> = []

    class CryptoHasher implements RuntimeHasher {
      constructor(algorithm: string) {
        algorithms.push(algorithm)
      }

      update(data: string | Uint8Array): this {
        updates.push(data)
        return this
      }

      digest(encoding: "hex"): string {
        return `native-${encoding}`
      }
    }

    const result = createRuntimeHasher("sha256", { CryptoHasher }).update("content").digest("hex")

    expect(result).toBe("native-hex")
    expect(algorithms).toEqual(["sha256"])
    expect(updates).toEqual(["content"])
  })

  it("falls back when the Bun capability is missing or non-callable", () => {
    const expected = createHash("sha256").update("content").digest("hex")

    expect(createRuntimeHasher("sha256", null).update("content").digest("hex")).toBe(expected)
    expect(
      createRuntimeHasher("sha256", { CryptoHasher: "not-callable" as never })
        .update("content")
        .digest("hex")
    ).toBe(expected)
  })
})

describe("hashHex", () => {
  it("matches Node SHA-256 for strings and bytes", () => {
    for (const input of ["content", Buffer.from([0, 1, 2, 255])]) {
      expect(hashHex("sha256", input)).toBe(createHash("sha256").update(input).digest("hex"))
    }
  })
})
