import {
  encryptSharePayload,
  decryptShareEnvelope,
  envelopeRequiresPassphrase,
  ShareIntegrityError,
  SharePassphraseRequiredError,
} from "./crypto"
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
