import {
  aes128DecryptBlock,
  decryptIlinkMedia,
  base64ToBytes,
  bytesToBase64,
  fetchAndDecryptIlinkMedia,
} from "./media"

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
}

// FIPS-197 Appendix C.1 known-answer vector.
const KEY = hexToBytes("000102030405060708090a0b0c0d0e0f")
const CT = hexToBytes("69c4e0d86a7b0430d8cdb78070b4c55a")
const PT = "00112233445566778899aabbccddeeff"

describe("aes128DecryptBlock (FIPS-197 C.1)", () => {
  it("decrypts the standard known-answer block", () => {
    expect(bytesToHex(aes128DecryptBlock(CT, KEY))).toBe(PT)
  })

  it("rejects non-16-byte block/key", () => {
    expect(() => aes128DecryptBlock(new Uint8Array(15), KEY)).toThrow()
  })
})

describe("decryptIlinkMedia (ECB + PKCS7)", () => {
  it("decrypts multi-block ECB ciphertext with a raw-bytes base64 key", () => {
    // Two FIPS blocks → two PT blocks. PT's last byte 0xff > 16 ⇒ unpad is a
    // no-op, so we get the raw plaintext back.
    const ct = new Uint8Array(32)
    ct.set(CT, 0)
    ct.set(CT, 16)
    const out = decryptIlinkMedia(ct, bytesToBase64(KEY))
    expect(bytesToHex(out)).toBe(PT + PT)
  })

  it("accepts a hex-string-form key (32 ASCII chars base64-encoded)", () => {
    const hexKeyAscii = "000102030405060708090a0b0c0d0e0f" // 32 chars
    const keyB64 = bytesToBase64(new TextEncoder().encode(hexKeyAscii))
    expect(bytesToHex(decryptIlinkMedia(CT, keyB64))).toBe(PT)
  })

  it("throws on non-block-aligned ciphertext", () => {
    expect(() => decryptIlinkMedia(new Uint8Array(20), bytesToBase64(KEY))).toThrow(
      /multiple of 16/
    )
  })
})

describe("base64 helpers", () => {
  it("round-trips bytes", () => {
    const b = new Uint8Array([0, 255, 16, 200])
    expect(Array.from(base64ToBytes(bytesToBase64(b)))).toEqual([0, 255, 16, 200])
  })
})

describe("fetchAndDecryptIlinkMedia", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it("returns raw bytes when no key is given", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })) as unknown as typeof fetch
    expect(Array.from(await fetchAndDecryptIlinkMedia("https://cdn/x"))).toEqual([1, 2, 3])
  })

  it("throws on a non-ok response", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
    await expect(fetchAndDecryptIlinkMedia("https://cdn/x")).rejects.toThrow(/404/)
  })
})
