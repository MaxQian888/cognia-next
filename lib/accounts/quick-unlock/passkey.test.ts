/** @jest-environment jsdom */

import {
  canonicalizePasskeySecret,
  decodeBase64Url,
  derivePasskeySecret,
  encodeBase64Url,
  enrollPasskey,
  hasPlatformAuthenticator,
  isPasskeySupported,
} from "./passkey"

interface FakeCredential {
  rawId: ArrayBuffer
  getClientExtensionResults: () => unknown
}

const create = jest.fn()
const get = jest.fn()

function installWebAuthn(options: { secureContext?: boolean; platform?: boolean } = {}): void {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: options.secureContext ?? true,
  })
  Object.defineProperty(window, "PublicKeyCredential", {
    configurable: true,
    writable: true,
    value: Object.assign(function PublicKeyCredential() {}, {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => options.platform ?? true,
    }),
  })
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    writable: true,
    value: { create, get },
  })
}

function removeWebAuthn(): void {
  Object.defineProperty(window, "PublicKeyCredential", {
    configurable: true,
    writable: true,
    value: undefined,
  })
}

function credential(extensions: unknown, id = new Uint8Array([1, 2, 3, 4])): FakeCredential {
  return {
    rawId: id.buffer.slice(0) as ArrayBuffer,
    getClientExtensionResults: () => extensions,
  }
}

const PRF_BYTES = new Uint8Array(32).fill(9)

beforeEach(() => {
  jest.clearAllMocks()
  installWebAuthn()
})

describe("isPasskeySupported", () => {
  it("reports support when the API is present in a secure context", () => {
    expect(isPasskeySupported()).toBe(true)
  })

  it("reports no support without the API", () => {
    removeWebAuthn()
    expect(isPasskeySupported()).toBe(false)
  })

  it("reports no support outside a secure context", () => {
    // WebAuthn is a hard secure-context requirement. Saying so up front beats
    // a rejected promise the user reads as a broken feature.
    installWebAuthn({ secureContext: false })
    expect(isPasskeySupported()).toBe(false)
  })
})

describe("hasPlatformAuthenticator", () => {
  it("reports a platform authenticator when one exists", async () => {
    installWebAuthn({ platform: true })
    expect(await hasPlatformAuthenticator()).toBe(true)
  })

  it("reports none when the check says so", async () => {
    installWebAuthn({ platform: false })
    expect(await hasPlatformAuthenticator()).toBe(false)
  })

  it("reports none rather than throwing when the API is absent", async () => {
    removeWebAuthn()
    expect(await hasPlatformAuthenticator()).toBe(false)
  })
})

describe("enrollPasskey", () => {
  const args = { localAccountId: "acct-001", displayName: "Ada" }

  it("returns the credential and its PRF secret", async () => {
    create.mockResolvedValue(
      credential({ prf: { enabled: true, results: { first: PRF_BYTES.buffer.slice(0) } } })
    )
    const result = await enrollPasskey({ ...args, now: 1000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.secret).toHaveLength(32)
    expect(result.value.enrollment.createdAt).toBe(1000)
    expect(result.value.enrollment.credentialId).toBe(encodeBase64Url(new Uint8Array([1, 2, 3, 4])))
  })

  it("requests the PRF extension rather than a plain assertion", async () => {
    create.mockResolvedValue(
      credential({ prf: { enabled: true, results: { first: PRF_BYTES.buffer.slice(0) } } })
    )
    await enrollPasskey(args)
    const options = create.mock.calls[0][0].publicKey
    expect(options.extensions.prf.eval.first).toBeDefined()
    expect(options.authenticatorSelection.userVerification).toBe("required")
  })

  it("refuses an authenticator that does not support PRF", async () => {
    // The quiet failure this exists to catch: registration succeeds, the
    // extension is simply absent, and a plain assertion can never produce a
    // key. Enrolling anyway would create a method that cannot unlock anything.
    create.mockResolvedValue(credential({}))
    expect(await enrollPasskey(args)).toEqual({ ok: false, reason: "no-prf" })
  })

  it("falls back to an assertion when PRF is enabled but returns no results yet", async () => {
    // Some authenticators report support at creation and only produce output
    // on the first assertion.
    create.mockResolvedValue(credential({ prf: { enabled: true } }))
    get.mockResolvedValue(credential({ prf: { results: { first: PRF_BYTES.buffer.slice(0) } } }))
    const result = await enrollPasskey(args)
    expect(result.ok).toBe(true)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("reports a user cancellation distinctly from a failure", async () => {
    const cancelled = new Error("denied")
    cancelled.name = "NotAllowedError"
    create.mockRejectedValue(cancelled)
    expect(await enrollPasskey(args)).toEqual({ ok: false, reason: "cancelled" })
  })

  it("reports an unexpected error as a failure", async () => {
    create.mockRejectedValue(new Error("boom"))
    expect(await enrollPasskey(args)).toEqual({ ok: false, reason: "failed" })
  })

  it("reports an absent API without prompting", async () => {
    removeWebAuthn()
    expect(await enrollPasskey(args)).toEqual({ ok: false, reason: "unsupported" })
    expect(create).not.toHaveBeenCalled()
  })

  it("salts the PRF input per account so two accounts derive different secrets", async () => {
    create.mockResolvedValue(
      credential({ prf: { enabled: true, results: { first: PRF_BYTES.buffer.slice(0) } } })
    )
    await enrollPasskey({ localAccountId: "acct-one", displayName: "A" })
    await enrollPasskey({ localAccountId: "acct-two", displayName: "B" })

    const first = new Uint8Array(create.mock.calls[0][0].publicKey.extensions.prf.eval.first)
    const second = new Uint8Array(create.mock.calls[1][0].publicKey.extensions.prf.eval.first)
    expect(Array.from(first)).not.toEqual(Array.from(second))
  })
})

describe("derivePasskeySecret", () => {
  const args = {
    localAccountId: "acct-001",
    credentialId: encodeBase64Url(new Uint8Array([1, 2, 3])),
  }

  it("returns stable bytes from the assertion", async () => {
    get.mockResolvedValue(credential({ prf: { results: { first: PRF_BYTES.buffer.slice(0) } } }))
    const result = await derivePasskeySecret(args)
    expect(result).toEqual({ ok: true, value: PRF_BYTES })
  })

  it("restricts the assertion to the enrolled credential", async () => {
    get.mockResolvedValue(credential({ prf: { results: { first: PRF_BYTES.buffer.slice(0) } } }))
    await derivePasskeySecret(args)
    const options = get.mock.calls[0][0].publicKey
    expect(options.allowCredentials).toHaveLength(1)
    expect(options.userVerification).toBe("required")
  })

  it("reports a missing PRF result rather than returning empty bytes", async () => {
    get.mockResolvedValue(credential({}))
    expect(await derivePasskeySecret(args)).toEqual({ ok: false, reason: "no-prf" })
  })

  it("reports cancellation", async () => {
    const cancelled = new Error("denied")
    cancelled.name = "NotAllowedError"
    get.mockRejectedValue(cancelled)
    expect(await derivePasskeySecret(args)).toEqual({ ok: false, reason: "cancelled" })
  })
})

describe("base64url round trip", () => {
  it("survives bytes that need URL-safe characters", () => {
    const bytes = new Uint8Array([251, 255, 190, 0, 1, 127, 128])
    const encoded = encodeBase64Url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(Array.from(decodeBase64Url(encoded))).toEqual(Array.from(bytes))
  })

  it("namespaces the passkey secret like the other methods", () => {
    expect(canonicalizePasskeySecret(new Uint8Array([1, 2, 3]))).toMatch(/^passkey:/)
  })
})
