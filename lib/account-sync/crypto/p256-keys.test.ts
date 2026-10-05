import { fromBase64Url, toBase64Url } from "@cognia/sync-protocol"

import { generateP256Jwk, importP256KeyPair, jwkFromScalar, rawPointFromJwk } from "./p256-keys"

describe("P-256 key helpers", () => {
  it("generates a complete private JWK for each use", async () => {
    for (const use of ["sign", "enc"] as const) {
      const jwk = await generateP256Jwk(use)
      expect(Object.keys(jwk).sort()).toEqual(["crv", "d", "kty", "x", "y"])
      expect(fromBase64Url(jwk.d)).toHaveLength(32)
    }
  })

  it("imports a signing pair with a non-extractable private half", async () => {
    const pair = await importP256KeyPair(await generateP256Jwk("sign"), "sign")
    expect(pair.privateKey.extractable).toBe(false)
    expect(pair.privateKey.usages).toEqual(["sign"])
    expect(pair.publicKey.usages).toEqual(["verify"])
    const data = new Uint8Array([4, 2])
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data)
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, sig, data)
    ).toBe(true)
  })

  it("imports an ECDH pair whose public half exports raw", async () => {
    const jwk = await generateP256Jwk("enc")
    const pair = await importP256KeyPair(jwk, "enc")
    expect(pair.privateKey.extractable).toBe(false)
    expect(pair.privateKey.usages).toEqual(["deriveBits"])
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
    expect(raw).toEqual(rawPointFromJwk(jwk))
  })

  it("converts between scalars, points and JWKs", () => {
    const point = new Uint8Array(65).fill(3)
    point[0] = 4
    const jwk = jwkFromScalar(new Uint8Array(32).fill(1), point)
    expect(jwk.d).toBe(toBase64Url(new Uint8Array(32).fill(1)))
    expect(rawPointFromJwk(jwk)).toEqual(point)
    expect(() => jwkFromScalar(new Uint8Array(31), point)).toThrow()
    expect(() => jwkFromScalar(new Uint8Array(32), point.subarray(1))).toThrow()
    expect(() => rawPointFromJwk({ x: toBase64Url(new Uint8Array(31)), y: jwk.y })).toThrow(
      /32 bytes/
    )
  })

  it("refuses a JWK whose public point does not match its scalar", async () => {
    const a = await generateP256Jwk("sign")
    const b = await generateP256Jwk("sign")
    await expect(importP256KeyPair({ ...a, x: b.x, y: b.y }, "sign")).rejects.toThrow()
  })
})
