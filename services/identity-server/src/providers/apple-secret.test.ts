import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose"
import { afterEach, describe, expect, it } from "vitest"

import {
  APPLE_AUDIENCE,
  APPLE_SECRET_TTL_SECONDS,
  mintAppleClientSecret,
  normalizePem,
  resetAppleSecretCache,
} from "./apple-secret"

function pem(label: string, bytes: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)))
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----`
}

async function appleKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  return {
    privatePem: pem(
      "PRIVATE KEY",
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer
    ),
    publicPem: pem(
      "PUBLIC KEY",
      (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer
    ),
  }
}

describe("mintAppleClientSecret", () => {
  afterEach(() => resetAppleSecretCache())

  it("signs the JWT Apple expects with the team's key", async () => {
    const key = await appleKey()
    const credentials = {
      serviceId: "cn.cognia.signin",
      teamId: "TEAM123",
      keyId: "KEY456",
      privateKey: key.privatePem,
    }
    const now = 1_800_000_000
    const secret = await mintAppleClientSecret(credentials, now)
    expect(decodeProtectedHeader(secret)).toEqual({ alg: "ES256", kid: "KEY456" })
    const { payload } = await jwtVerify(secret, await importSPKI(key.publicPem, "ES256"), {
      issuer: "TEAM123",
      subject: "cn.cognia.signin",
      audience: APPLE_AUDIENCE,
      currentDate: new Date((now + 60) * 1000),
    })
    expect(payload.exp! - payload.iat!).toBe(APPLE_SECRET_TTL_SECONDS)
  })

  it("reuses a secret until shortly before it expires, and re-mints for another key", async () => {
    const key = await appleKey()
    const credentials = { serviceId: "s", teamId: "t", keyId: "k", privateKey: key.privatePem }
    const first = await mintAppleClientSecret(credentials, 1_800_000_000)
    expect(await mintAppleClientSecret(credentials, 1_800_000_000 + 3600)).toBe(first)
    expect(
      await mintAppleClientSecret(credentials, 1_800_000_000 + APPLE_SECRET_TTL_SECONDS - 60)
    ).not.toBe(first)
    const other = await appleKey()
    expect(
      await mintAppleClientSecret({ ...credentials, privateKey: other.privatePem }, 1_800_000_000)
    ).not.toBe(first)
  })

  it("accepts a PEM stored with escaped newlines", async () => {
    const key = await appleKey()
    const escaped = key.privatePem.replace(/\n/g, "\\n")
    expect(normalizePem(escaped)).toBe(key.privatePem)
    await expect(
      mintAppleClientSecret(
        { serviceId: "s", teamId: "t", keyId: "k", privateKey: escaped },
        1_800_000_000
      )
    ).resolves.toMatch(/^ey/)
  })
})
