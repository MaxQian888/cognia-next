/**
 * Trust-state resolution for Character Packs.
 *
 * The invariant under test throughout: a pack that CARRIES a signature which
 * does not verify is refused, and is never downgraded to `unsigned`.
 */

const mockVerifyPackPayloadSignature = jest.fn()

jest.mock("@/lib/plugin/security/signature", () => ({
  verifyPackPayloadSignature: (...args: unknown[]) =>
    mockVerifyPackPayloadSignature(...(args as [])),
  shortFingerprint: (fp: string) => `ed25519:${fp.slice(0, 4)}`,
}))

import { resolvePackTrust, UNSIGNED_TRUST } from "./pack-trust"
import { canonicalPackString } from "./canonical-json"
import type { LocalCharacterPackFile } from "./schema"
import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"

const pack = (): PluginCharacterPackDef =>
  ({
    id: "workplace",
    name: "Workplace",
    version: "1.0.0",
    characters: [{ localId: "c1", name: "One", avatarColor: "#fff", systemPrompt: "hello" }],
  }) as PluginCharacterPackDef

const signature = { algo: "ed25519" as const, pubKey: "PUBKEY", sig: "SIG" }

const file = (over: Partial<LocalCharacterPackFile> = {}): LocalCharacterPackFile =>
  ({ schemaVersion: 2, pack: pack(), ...over }) as LocalCharacterPackFile

const verdict = (over: Record<string, unknown> = {}) => ({
  requestId: "r",
  verified: true,
  packId: "workplace",
  packVersion: "1.0.0",
  fingerprint: "9f3a".padEnd(64, "0"),
  payloadBytes: 10,
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockVerifyPackPayloadSignature.mockResolvedValue(verdict())
})

describe("unsigned packs", () => {
  it("resolve to unsigned without calling the verifier", async () => {
    const result = await resolvePackTrust(file())
    expect(result).toEqual({ ok: true, trust: UNSIGNED_TRUST })
    expect(mockVerifyPackPayloadSignature).not.toHaveBeenCalled()
  })

  it("remain fully usable — unsigned is an accepted state, not a failure", async () => {
    const result = await resolvePackTrust(file())
    expect(result.ok).toBe(true)
  })
})

describe("verified packs", () => {
  it("carry the fingerprint, key, and the ORIGINAL signature block", async () => {
    const result = await resolvePackTrust(file({ signature }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.trust).toMatchObject({
      state: "verified",
      algo: "ed25519",
      publicKey: "PUBKEY",
      shortFingerprint: "ed25519:9f3a",
    })
    // Retained verbatim so exportPack can write it back and the file still
    // verifies on re-import.
    if (result.trust.state !== "verified") throw new Error("expected verified")
    expect(result.trust.signature).toBe(signature)
  })

  it("verify the canonical pack payload, not the raw file", async () => {
    const f = file({ signature })
    await resolvePackTrust(f)
    expect(mockVerifyPackPayloadSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        packId: "workplace",
        packVersion: "1.0.0",
        payload: canonicalPackString(f.pack),
        signatureBase64: "SIG",
        publicKeyBase64: "PUBKEY",
      })
    )
  })

  it("signs bytes that exclude the wrapper, so a schema bump stays valid", async () => {
    const v1 = file({ schemaVersion: 1, signature })
    const v2 = file({ schemaVersion: 2, signature })
    await resolvePackTrust(v1)
    const payloadV1 = mockVerifyPackPayloadSignature.mock.calls[0][0].payload
    mockVerifyPackPayloadSignature.mockClear()
    await resolvePackTrust(v2)
    const payloadV2 = mockVerifyPackPayloadSignature.mock.calls[0][0].payload
    expect(payloadV1).toBe(payloadV2)
  })
})

describe("refusal — never downgraded to unsigned", () => {
  it("refuses a signature that does not verify", async () => {
    mockVerifyPackPayloadSignature.mockResolvedValue(
      verdict({ verified: false, reason: "signature-mismatch" })
    )
    const result = await resolvePackTrust(file({ signature }))
    expect(result).toEqual({ ok: false, reason: "signature-mismatch" })
  })

  it("fails closed when the host cannot verify at all", async () => {
    // If we cannot check a signature that is present, we do not get to assume
    // it was fine. This is the rule that stops a browser-mode import from
    // laundering a tampered pack into a usable one.
    mockVerifyPackPayloadSignature.mockResolvedValue(
      verdict({ verified: false, reason: "host-unavailable" })
    )
    const result = await resolvePackTrust(file({ signature }))
    expect(result).toEqual({ ok: false, reason: "host-unavailable" })
  })

  it.each(["payload-too-large", "bad-public-key", "bad-signature-encoding"])(
    "refuses on reason=%s",
    async (reason) => {
      mockVerifyPackPayloadSignature.mockResolvedValue(verdict({ verified: false, reason }))
      const result = await resolvePackTrust(file({ signature }))
      expect(result).toEqual({ ok: false, reason })
    }
  )

  it("supplies a reason even when the verdict omits one", async () => {
    mockVerifyPackPayloadSignature.mockResolvedValue(verdict({ verified: false }))
    const result = await resolvePackTrust(file({ signature }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.reason).toBe("signature-mismatch")
  })

  it("refuses a signed pack that cannot be canonicalised", async () => {
    // A signed pack we cannot even turn into bytes is not verifiable, so it is
    // refused rather than treated as unsigned.
    const broken = file({ signature })
    ;(broken.pack as unknown as Record<string, unknown>).bad = Number.NaN
    const result = await resolvePackTrust(broken)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.reason).toContain("canonicalization failed")
    expect(mockVerifyPackPayloadSignature).not.toHaveBeenCalled()
  })
})

describe("the type cannot represent a tampered pack", () => {
  it("has no `invalid` trust state — refusal is the only outcome", async () => {
    mockVerifyPackPayloadSignature.mockResolvedValue(
      verdict({ verified: false, reason: "signature-mismatch" })
    )
    const result = await resolvePackTrust(file({ signature }))
    // There is deliberately no third state: a caller is forced to branch on
    // `ok` and cannot accidentally register the pack with a lesser badge.
    expect("trust" in result).toBe(false)
  })
})
