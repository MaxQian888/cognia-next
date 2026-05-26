import { generateShareKey, encodeShareKey, decodeShareKey, SHARE_KEY_BYTES } from "./keys"

describe("share keys", () => {
  it("generates a 32-byte key", () => {
    expect(generateShareKey().length).toBe(SHARE_KEY_BYTES)
  })

  it("generates different keys each call", () => {
    expect(encodeShareKey(generateShareKey())).not.toBe(encodeShareKey(generateShareKey()))
  })

  it("round-trips a key through url-safe encoding", () => {
    const key = generateShareKey()
    expect(Array.from(decodeShareKey(encodeShareKey(key)))).toEqual(Array.from(key))
  })

  it("rejects a key of the wrong length", () => {
    const short = encodeShareKey(new Uint8Array(16))
    expect(() => decodeShareKey(short)).toThrow(/Invalid share key length/)
  })
})
