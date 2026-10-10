import {
  encryptSharePayload,
  encryptSharePayloadWithMaterial,
  decryptShareEnvelope,
  envelopeRequiresPassphrase,
  openShareEnvelope,
  prepareShareKeyMaterial,
  recoverShareKeyMaterial,
  ShareIntegrityError,
  SharePassphraseRequiredError,
} from "./crypto"
import { encodeBase64 } from "./encoding"
import { generateShareKey } from "./keys"
import { sha256Hex } from "./hash"
import type { SharePayload } from "./types"

const PAYLOAD: SharePayload = {
  kind: "chat-html",
  mime: "text/html",
  data: "<h1>hello</h1>",
  encoding: "utf8",
  title: "Demo",
}

describe("encryptSharePayload / decryptShareEnvelope — raw key", () => {
  it("round-trips a payload with a raw key, no passphrase", async () => {
    const key = generateShareKey()
    const env = await encryptSharePayload(PAYLOAD, key)
    expect(env.v).toBe(1)
    expect(env.alg).toBe("AES-GCM")
    expect(env.pp).toBeUndefined()
    expect(envelopeRequiresPassphrase(env)).toBe(false)

    const recovered = await decryptShareEnvelope(env, key)
    expect(recovered).toEqual(PAYLOAD)
  })

  it("produces fresh ciphertext + iv for the same payload", async () => {
    const key = generateShareKey()
    const a = await encryptSharePayload(PAYLOAD, key)
    const b = await encryptSharePayload(PAYLOAD, key)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.iv).not.toBe(b.iv)
  })

  it("fails to decrypt with a different key", async () => {
    const env = await encryptSharePayload(PAYLOAD, generateShareKey())
    await expect(decryptShareEnvelope(env, generateShareKey())).rejects.toBeDefined()
  })

  it("checksum equals sha256 of the plaintext json", async () => {
    const key = generateShareKey()
    const env = await encryptSharePayload(PAYLOAD, key)
    expect(env.checksum).toBe(await sha256Hex(JSON.stringify(PAYLOAD)))
  })

  it("throws ShareIntegrityError when the checksum is tampered", async () => {
    const key = generateShareKey()
    const env = await encryptSharePayload(PAYLOAD, key)
    const tampered = { ...env, checksum: "0".repeat(64) }
    await expect(decryptShareEnvelope(tampered, key)).rejects.toBeInstanceOf(ShareIntegrityError)
  })
})

describe("encryptSharePayload / decryptShareEnvelope — extra passphrase", () => {
  it("requires both the raw key and the passphrase", async () => {
    const key = generateShareKey()
    const env = await encryptSharePayload(PAYLOAD, key, "hunter2")
    expect(envelopeRequiresPassphrase(env)).toBe(true)
    expect(env.pp?.kdf).toBe("PBKDF2")
    expect(typeof env.pp?.salt).toBe("string")

    const recovered = await decryptShareEnvelope(env, key, "hunter2")
    expect(recovered).toEqual(PAYLOAD)
  })

  it("throws SharePassphraseRequiredError when the passphrase is missing", async () => {
    const key = generateShareKey()
    const env = await encryptSharePayload(PAYLOAD, key, "hunter2")
    await expect(decryptShareEnvelope(env, key)).rejects.toBeInstanceOf(
      SharePassphraseRequiredError
    )
  })

  it("fails with the right key but a wrong passphrase", async () => {
    const key = generateShareKey()
    const env = await encryptSharePayload(PAYLOAD, key, "correct")
    await expect(decryptShareEnvelope(env, key, "wrong")).rejects.toBeDefined()
  })

  it("fails with the right passphrase but a wrong key", async () => {
    const env = await encryptSharePayload(PAYLOAD, generateShareKey(), "correct")
    await expect(decryptShareEnvelope(env, generateShareKey(), "correct")).rejects.toBeDefined()
  })
})

describe("binary payloads", () => {
  it("round-trips base64-encoded binary data", async () => {
    const key = generateShareKey()
    const binary: SharePayload = {
      kind: "workflow-png",
      mime: "image/png",
      data: "iVBORw0KGgo=",
      encoding: "base64",
    }
    const env = await encryptSharePayload(binary, key)
    expect(await decryptShareEnvelope(env, key)).toEqual(binary)
  })
})

describe("share key material (ADR-0222)", () => {
  it("is the raw key itself when there is no passphrase", async () => {
    const key = generateShareKey()
    const material = await prepareShareKeyMaterial(key)
    expect(material.bytes).toBe(key)
    expect(material.pp).toBeUndefined()
    const env = await encryptSharePayloadWithMaterial(PAYLOAD, material)
    await expect(openShareEnvelope(env, key)).resolves.toEqual({ payload: PAYLOAD, material: key })
  })

  it("derives 32 bytes from key and passphrase that the reader recovers exactly", async () => {
    const key = generateShareKey()
    const material = await prepareShareKeyMaterial(key, "hunter2")
    expect(material.bytes).toHaveLength(32)
    expect(material.pp?.iterations).toBe(600_000)
    const env = await encryptSharePayloadWithMaterial(PAYLOAD, material)
    expect(env.pp).toEqual(material.pp)
    const opened = await openShareEnvelope(env, key, "hunter2")
    expect(opened.payload).toEqual(PAYLOAD)
    expect(Array.from(opened.material)).toEqual(Array.from(material.bytes))
    expect(Array.from(await recoverShareKeyMaterial(env, key, "hunter2"))).toEqual(
      Array.from(material.bytes)
    )
    await expect(recoverShareKeyMaterial(env, key)).rejects.toBeInstanceOf(
      SharePassphraseRequiredError
    )
  })

  it("still opens passphrase envelopes sealed with a PBKDF2-derived AES key", async () => {
    // Envelopes created before the material refactor derived a non-extractable
    // AES key with `deriveKey`; `deriveBits` + import must be the same key.
    const subtle = globalThis.crypto.subtle
    const key = generateShareKey()
    const passphrase = "legacy"
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const joined = new Uint8Array([...key, ...new TextEncoder().encode(passphrase)])
    const base = await subtle.importKey("raw", joined, "PBKDF2", false, ["deriveKey"])
    const aes = await subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 1_000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    )
    const plainText = JSON.stringify(PAYLOAD)
    const ciphertext = await subtle.encrypt(
      { name: "AES-GCM", iv },
      aes,
      new TextEncoder().encode(plainText)
    )
    const env = {
      v: 1 as const,
      alg: "AES-GCM" as const,
      pp: {
        kdf: "PBKDF2" as const,
        hash: "SHA-256" as const,
        iterations: 1_000,
        salt: encodeBase64(salt),
      },
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      checksum: await sha256Hex(plainText),
    }
    await expect(decryptShareEnvelope(env, key, passphrase)).resolves.toEqual(PAYLOAD)
  })
})
