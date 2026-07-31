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

  it("maps the plugin's numeric biometry enum onto the string union", async () => {
    // Real devices report a number (FACE_ID = 2), not the string.
    const bio = makeBio({
      isAvailable: jest.fn().mockResolvedValue({ isAvailable: true, biometryType: 2 }),
    })
    const out = await isAvailable(async () => bio)
    expect(out).toEqual({
      kind: "ok",
      value: { available: true, biometryType: "FACE_ID" },
    })
  })

  it("maps an unknown numeric enum value to NONE", async () => {
    const bio = makeBio({
      isAvailable: jest.fn().mockResolvedValue({ isAvailable: true, biometryType: 42 }),
    })
    const out = await isAvailable(async () => bio)
    expect(out).toEqual({
      kind: "ok",
      value: { available: true, biometryType: "NONE" },
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

  it("classifies by the plugin's numeric error code before the message text", async () => {
    // Localized message that no regex matches, but code 16 = user cancel.
    const cancelErr = Object.assign(new Error("用户已取消认证"), { code: "16" })
    const bio = makeBio({ verifyIdentity: jest.fn().mockRejectedValue(cancelErr) })
    expect(await verify({ reason: "x", loader: async () => bio })).toEqual({ kind: "cancelled" })

    const lockoutErr = Object.assign(new Error("尝试次数过多"), { code: 4 })
    const bio2 = makeBio({ verifyIdentity: jest.fn().mockRejectedValue(lockoutErr) })
    expect(await verify({ reason: "x", loader: async () => bio2 })).toEqual({ kind: "lockout" })

    const notEnrolledErr = Object.assign(new Error("未注册生物识别"), { code: 3 })
    const bio3 = makeBio({ verifyIdentity: jest.fn().mockRejectedValue(notEnrolledErr) })
    expect(await verify({ reason: "x", loader: async () => bio3 })).toEqual({
      kind: "unavailable",
    })
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
