import { base64UrlToBytes, base64UrlToText } from "./base64url"
import type { DeviceSigner } from "./device-signer"
import { createDeviceProof } from "./dpop"
import { signerFromCryptoKey } from "./device-signer"

function recordingSigner(): DeviceSigner & { signed: string[] } {
  const signed: string[] = []
  return {
    deviceId: "device-a",
    thumbprint: "thumb-a",
    signed,
    async sign(data) {
      signed.push(new TextDecoder().decode(data))
      return new Uint8Array([1, 2, 3, 4])
    },
  }
}

function parts(proof: string) {
  const [header, payload, signature] = proof.split(".")
  return {
    header: JSON.parse(base64UrlToText(header)) as Record<string, unknown>,
    payload: JSON.parse(base64UrlToText(payload)) as Record<string, unknown>,
    signature,
  }
}

describe("createDeviceProof", () => {
  it("omits the jwk header the RFC would require", async () => {
    // The Host registered the key and looks it up by deviceId. Shipping it on
    // every request would add a second, disagreeing source of truth for which
    // key is current — and a stock RFC 9449 library would put it there.
    const { header } = parts(
      await createDeviceProof({
        signer: recordingSigner(),
        nonce: "n",
        method: "post",
        path: "/api/auth/token",
        nowSeconds: 1_000,
      })
    )
    expect(header).toEqual({ alg: "ES256", typ: "dpop+jwt" })
    expect(header).not.toHaveProperty("jwk")
  })

  it("puts a bare path in htu, not an absolute URI", async () => {
    // The Host answers on several base URLs at once (LAN HTTPS, a tunnel,
    // plaintext loopback). Binding the proof to one would invalidate it on the
    // others for no gain — the plane is already authenticated.
    const { payload } = parts(
      await createDeviceProof({
        signer: recordingSigner(),
        nonce: "n",
        method: "post",
        path: "/api/_rpc/browser_context_submit",
        nowSeconds: 1_000,
      })
    )
    expect(payload.htu).toBe("/api/_rpc/browser_context_submit")
    expect(payload.htm).toBe("POST")
  })

  it("expires 60 seconds after iat", async () => {
    const { payload } = parts(
      await createDeviceProof({
        signer: recordingSigner(),
        nonce: "n",
        method: "GET",
        path: "/x",
        nowSeconds: 1_000,
      })
    )
    expect(payload.iat).toBe(1_000)
    expect(payload.exp).toBe(1_060)
  })

  it("mints a fresh jti per proof so the replay cache can do its job", async () => {
    const signer = recordingSigner()
    const one = parts(
      await createDeviceProof({ signer, nonce: "n", method: "GET", path: "/x", nowSeconds: 1 })
    )
    const two = parts(
      await createDeviceProof({ signer, nonce: "n", method: "GET", path: "/x", nowSeconds: 1 })
    )
    expect(one.payload.jti).not.toBe(two.payload.jti)
  })

  it("carries the nonce it was handed, whichever of its two roles it is in", async () => {
    for (const nonce of ["challenge-nonce", "access-token-jti"]) {
      const { payload } = parts(
        await createDeviceProof({
          signer: recordingSigner(),
          nonce,
          method: "GET",
          path: "/x",
          nowSeconds: 1,
        })
      )
      expect(payload.nonce).toBe(nonce)
    }
  })

  it("signs exactly the header.payload it emits", async () => {
    const signer = recordingSigner()
    const proof = await createDeviceProof({
      signer,
      nonce: "n",
      method: "GET",
      path: "/x",
      nowSeconds: 1,
    })
    const [header, payload, signature] = proof.split(".")
    expect(signer.signed).toEqual([`${header}.${payload}`])
    expect(signature).toBe("AQIDBA")
  })

  it("produces a signature a real P-256 key verifies", async () => {
    // Guards the byte handling in `signerFromCryptoKey`: a subarray view would
    // sign the whole backing buffer and still return a plausible-looking blob.
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])
    const proof = await createDeviceProof({
      signer: signerFromCryptoKey("device-a", "thumb-a", pair.privateKey),
      nonce: "n",
      method: "POST",
      path: "/api/auth/token",
      nowSeconds: 1,
    })
    const [header, payload, signature] = proof.split(".")
    const bytes = base64UrlToBytes(signature)
    // `Uint8Array<ArrayBufferLike>` is not assignable to `BufferSource` under
    // the DOM lib's stricter generic; take the concrete buffer.
    const signatureBuffer = bytes.slice().buffer as ArrayBuffer
    await expect(
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pair.publicKey,
        signatureBuffer,
        new TextEncoder().encode(`${header}.${payload}`)
      )
    ).resolves.toBe(true)
  })
})
