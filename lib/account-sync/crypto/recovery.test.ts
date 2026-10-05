import { DhkemP256HkdfSha256 } from "@hpke/core"

import { fromBase64Url, parseRecoveryKey, randomBytes } from "@cognia/sync-protocol"

import { AccountSyncCryptoError } from "./errors"
import {
  assertRecoveryKeysMatch,
  deriveP256KeyPair,
  deriveRecoveryKeys,
  newRecoveryKey,
} from "./recovery"

const hex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"))
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
const SPACE = "s".repeat(43)

describe("deriveP256KeyPair (RFC 9180 §7.1.3)", () => {
  it("matches the RFC 9180 A.3.1 recipient vector", () => {
    const { secretKey, publicKey } = deriveP256KeyPair(
      hex("668b37171f1072f3cf12ea8a236a45df23fc13b82af3609ad1e354f6ef817550")
    )
    expect(toHex(secretKey)).toBe(
      "f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2"
    )
    expect(toHex(publicKey)).toBe(
      "04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0"
    )
  })

  it("matches the RFC 9180 A.3.1 ephemeral vector", () => {
    const { secretKey } = deriveP256KeyPair(
      hex("4270e54ffd08d79d5928020af4686d8f6b7d35dbe470265f1f5aa22816ce860e")
    )
    expect(toHex(secretKey)).toBe(
      "4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb"
    )
  })

  it("agrees with @hpke/core's own DeriveKeyPair", async () => {
    const kem = new DhkemP256HkdfSha256()
    for (let i = 0; i < 4; i++) {
      const ikm = randomBytes(32)
      const ours = deriveP256KeyPair(ikm)
      const theirs = await kem.deriveKeyPair(ikm.slice().buffer)
      expect(toHex(new Uint8Array(await kem.serializePublicKey(theirs.publicKey)))).toBe(
        toHex(ours.publicKey)
      )
      expect(toHex(new Uint8Array(await kem.serializePrivateKey(theirs.privateKey)))).toBe(
        toHex(ours.secretKey)
      )
    }
  })
})

describe("deriveRecoveryKeys", () => {
  // Frozen: changing the derivation would lock every user out of their recovery key.
  const RECOVERY_KEY = "0123-4567-89AB-CDEF-GHJK-MNPQ-RW"
  const FROZEN = {
    signPub:
      "BPPyYLMPfzkNqQJX9gMGyDaFw4U1Z3c7AMEFyzn5-6A8sBVinjmvIxmqTCDWx_2D5LMuuhhkRla87BwLu73Sb3E",
    encPub:
      "BHCpq8p7uRlDKwmjPaW8viAkGnwxkqv5Njvjuaz41Z-Wof_xptkB7V8Xkq9spJvKAOqnRJkFj47ZlIbJil8WOVc",
  }

  it("is deterministic per recovery key and space, and returns usable key pairs", async () => {
    const rk = newRecoveryKey()
    expect(rk).toHaveLength(16)
    const a = await deriveRecoveryKeys(rk, SPACE)
    const b = await deriveRecoveryKeys(rk, SPACE)
    expect(a.signPub).toBe(b.signPub)
    expect(a.encPub).toBe(b.encPub)
    expect(a.signPub).not.toBe(a.encPub)
    expect(fromBase64Url(a.signPub)).toHaveLength(65)

    const other = await deriveRecoveryKeys(rk, "t".repeat(43))
    expect(other.signPub).not.toBe(a.signPub)
    expect(other.encPub).not.toBe(a.encPub)

    expect(a.sign.privateKey.extractable).toBe(false)
    expect(a.enc.privateKey.extractable).toBe(false)
    const data = new Uint8Array([1, 2, 3])
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      a.sign.privateKey,
      data
    )
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, b.sign.publicKey, sig, data)
    ).toBe(true)
  })

  it("derives the frozen keys of a known recovery key", async () => {
    const keys = await deriveRecoveryKeys(parseRecoveryKey(RECOVERY_KEY), SPACE)
    expect({ signPub: keys.signPub, encPub: keys.encPub }).toEqual(FROZEN)
  })

  it("refuses a key of the wrong length", async () => {
    await expect(deriveRecoveryKeys(new Uint8Array(15), SPACE)).rejects.toThrow(/16 bytes/)
  })

  it("matches only the registry's recovery keys", async () => {
    const keys = await deriveRecoveryKeys(newRecoveryKey(), SPACE)
    expect(() =>
      assertRecoveryKeysMatch(keys, { signPub: keys.signPub, encPub: keys.encPub })
    ).not.toThrow()
    const other = await deriveRecoveryKeys(newRecoveryKey(), SPACE)
    expect(() =>
      assertRecoveryKeysMatch(keys, { signPub: other.signPub, encPub: keys.encPub })
    ).toThrow(AccountSyncCryptoError)
    expect(() =>
      assertRecoveryKeysMatch(keys, { signPub: keys.signPub, encPub: other.encPub })
    ).toThrow(expect.objectContaining({ code: "recovery_mismatch" }))
  })
})
