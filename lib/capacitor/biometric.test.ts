/**
 * @jest-environment jsdom
 */
import { isAvailable, verify } from "./biometric"

function makeBio(overrides: Record<string, unknown> = {}) {
  return {
    isAvailable: jest.fn().mockResolvedValue({ isAvailable: true, biometryType: "FACE_ID" }),
    verifyIdentity: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as {
    isAvailable: jest.Mock
    verifyIdentity: jest.Mock
  }
}

describe("biometric.isAvailable", () => {
  it("returns available true with biometry type", async () => {
    const bio = makeBio()
    const out = await isAvailable(async () => bio)
    expect(out).toEqual({
      kind: "ok",
      value: { available: true, biometryType: "FACE_ID" },
    })
  })

  it("returns available false on unsupported platform", async () => {
    const out = await isAvailable(async () => {
      throw new Error("nope")
    })
    expect(out).toEqual({
      kind: "ok",
      value: { available: false, biometryType: "NONE" },
    })
  })
})

describe("biometric.verify", () => {
  it("returns verified on success", async () => {
    const bio = makeBio()
    const out = await verify({
      reason: "Unlock cognia",
      loader: async () => bio,
    })
    expect(out).toEqual({ kind: "verified" })
  })

  it("returns unavailable when device has no biometric enrolled", async () => {
    const bio = makeBio({
      isAvailable: jest.fn().mockResolvedValue({ isAvailable: false }),
    })
    const out = await verify({ reason: "x", loader: async () => bio })
    expect(out).toEqual({ kind: "unavailable" })
  })

  it("returns cancelled when user cancels", async () => {
    const bio = makeBio({
      verifyIdentity: jest.fn().mockRejectedValue(new Error("Authentication cancelled")),
    })
    const out = await verify({ reason: "x", loader: async () => bio })
    expect(out).toEqual({ kind: "cancelled" })
  })

  it("returns lockout for too-many-attempts", async () => {
    const bio = makeBio({
      verifyIdentity: jest.fn().mockRejectedValue(new Error("Too many attempts, lockout")),
    })
    const out = await verify({ reason: "x", loader: async () => bio })
    expect(out).toEqual({ kind: "lockout" })
  })

  it("returns error for unexpected throws", async () => {
    const bio = makeBio({
      verifyIdentity: jest.fn().mockRejectedValue(new Error("hardware fail")),
    })
    const out = await verify({ reason: "x", loader: async () => bio })
    expect(out).toEqual({ kind: "error", message: "hardware fail" })
  })

  it("returns unavailable when plugin missing entirely", async () => {
    const out = await verify({
      reason: "x",
      loader: async () => {
        throw new Error("no plugin")
      },
    })
    expect(out).toEqual({ kind: "unavailable" })
  })
})
