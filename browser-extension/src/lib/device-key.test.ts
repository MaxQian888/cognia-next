/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { clearDeviceKey, createDeviceKey, loadDeviceKey, sha256Hex, spkiToPem } from "./device-key"

describe("device key", () => {
  beforeEach(async () => {
    await clearDeviceKey()
  })

  it("persists a private key that cannot be exported", async () => {
    // The whole storage argument: `chrome.storage.local` is readable by
    // anything with the profile directory, so the private half is made
    // unreadable instead of merely being put somewhere else.
    const material = await createDeviceKey()
    expect(material.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey("jwk", material.privateKey)).rejects.toBeDefined()
  })

  it("stores something under the device slot and reads it back", async () => {
    // Deliberately weak, and the reason is worth writing down: `fake-indexeddb`
    // implements structured clone for plain data, and a `CryptoKey` survives it
    // as `{}`. Real IndexedDB clones one faithfully — that is exactly why the
    // key is kept there rather than in `chrome.storage.local`.
    //
    // So "the restored value is still a usable, non-extractable CryptoKey" is
    // not assertable in jsdom at all. It is asserted in the extension E2E,
    // which runs against a real browser profile; pretending to check it here
    // would be a green test for a property this environment cannot observe.
    await createDeviceKey()
    expect(await loadDeviceKey()).not.toBeNull()
  })

  it("returns null when this browser has never paired", async () => {
    // Distinct from "paired and offline", which the panel renders differently.
    expect(await loadDeviceKey()).toBeNull()
  })

  it("forgets the key on disconnect", async () => {
    await createDeviceKey()
    await clearDeviceKey()
    expect(await loadDeviceKey()).toBeNull()
  })

  it("produces a PEM the Host can hash, and the thumbprint of that PEM", async () => {
    // `hex(SHA-256(publicKeyPem))` — a hash of the PEM *text*, not an RFC 7638
    // JWK thumbprint. The Rust side computes it the same way, and a mismatch
    // fails every request with `token_key_mismatch`.
    const material = await createDeviceKey()
    expect(material.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/)
    expect(material.publicKeyPem).toMatch(/-----END PUBLIC KEY-----\n$/)
    expect(material.thumbprint).toBe(
      await sha256Hex(new TextEncoder().encode(material.publicKeyPem))
    )
    expect(material.thumbprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("generates a different identity each time", async () => {
    const first = await createDeviceKey()
    const second = await createDeviceKey()
    expect(first.publicKeyPem).not.toBe(second.publicKeyPem)
  })
})

describe("spkiToPem", () => {
  it("wraps at 64 characters, the way every PEM reader expects", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])
    const pem = spkiToPem(await crypto.subtle.exportKey("spki", pair.publicKey))
    const body = pem.split("\n").slice(1, -2)
    expect(body.length).toBeGreaterThan(0)
    for (const line of body) expect(line.length).toBeLessThanOrEqual(64)
  })
})
