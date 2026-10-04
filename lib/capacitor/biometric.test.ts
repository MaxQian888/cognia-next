/**
 * @jest-environment jsdom
 */
import { isAvailable, verify, withBiometricPromptLock } from "./biometric"

afterEach(() => Reflect.deleteProperty(window, "Capacitor"))

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
      value: { available: false, biometryType: "NONE", reason: "unsupported" },
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

  it("preserves weak-only availability and security metadata", async () => {
    const bio = makeBio({
      isAvailable: jest.fn().mockResolvedValue({
        isAvailable: true,
        biometryType: 4,
        authenticationStrength: 2,
        strongBiometryIsAvailable: false,
        deviceIsSecure: true,
      }),
    })
    expect(await isAvailable(async () => bio)).toEqual({
      kind: "ok",
      value: {
        available: true,
        biometryType: "FACE_AUTHENTICATION",
        authenticationStrength: 2,
        strongBiometryIsAvailable: false,
        deviceIsSecure: true,
      },
    })
  })

  it.each([
    [2, "lockout"],
    [4, "lockout"],
    [3, "not_enrolled"],
    [1, "temporarily_unavailable"],
    [0, "error"],
  ])("preserves native unavailability code %s", async (errorCode, reason) => {
    const bio = makeBio({
      isAvailable: jest.fn().mockResolvedValue({ isAvailable: false, errorCode }),
    })
    expect(await isAvailable(async () => bio)).toMatchObject({
      kind: "ok",
      value: { available: false, errorCode, reason },
    })
  })

  it("treats a missing native bridge as an error on mobile", async () => {
    Object.assign(window, {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
    })
    const loader = async () => {
      throw new Error("bridge unavailable")
    }
    expect(await isAvailable(loader)).toEqual({ kind: "error", message: "bridge unavailable" })
    expect(await verify({ reason: "x", loader })).toEqual({
      kind: "error",
      message: "bridge unavailable",
    })
  })

  it("does not infer enrollment from an unclassified false result", async () => {
    const bio = makeBio({ isAvailable: jest.fn().mockResolvedValue({ isAvailable: false }) })
    expect(await isAvailable(async () => bio)).toMatchObject({
      kind: "ok",
      value: { reason: "error" },
    })
    expect(await verify({ reason: "x", loader: async () => bio })).toMatchObject({ kind: "error" })
  })
})

describe("biometric.verify", () => {
  it("preserves a resolved iOS lockout instead of treating it as no enrollment", async () => {
    const bio = makeBio({
      isAvailable: jest.fn().mockResolvedValue({ isAvailable: false, errorCode: 2 }),
    })
    expect(await verify({ reason: "x", loader: async () => bio })).toEqual({ kind: "lockout" })
    expect(bio.verifyIdentity).not.toHaveBeenCalled()
  })

  it("blocks a temporarily unavailable sensor", async () => {
    const bio = makeBio({
      isAvailable: jest.fn().mockResolvedValue({ isAvailable: false, errorCode: 1 }),
    })
    expect(await verify({ reason: "x", loader: async () => bio })).toMatchObject({ kind: "error" })
  })

  it("recognizes Chinese app cancellation from a plain native error object", async () => {
    const bio = makeBio({
      verifyIdentity: jest.fn().mockRejectedValue({ code: "11", message: "应用取消" }),
    })
    expect(await verify({ reason: "x", loader: async () => bio })).toEqual({ kind: "cancelled" })
  })

  it("permits five Android attempts instead of ending after one mismatch", async () => {
    const bio = makeBio()
    await verify({ reason: "x", loader: async () => bio })
    expect(bio.verifyIdentity).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 5 }))
  })
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
      isAvailable: jest.fn().mockResolvedValue({ isAvailable: false, errorCode: 3 }),
    })
    const out = await verify({ reason: "x", loader: async () => bio })
    expect(out).toEqual({ kind: "unavailable", reason: "not_enrolled" })
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
      kind: "error",
      message: "未注册生物识别",
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
    expect(out).toEqual({ kind: "unavailable", reason: "unsupported" })
  })

  it.each([11, 15, 16, 17])("classifies Chinese cancellation code %s", async (code) => {
    const bio = makeBio({
      verifyIdentity: jest.fn().mockRejectedValue({ code, message: "认证已终止" }),
    })
    expect(await verify({ reason: "x", loader: async () => bio })).toEqual({ kind: "cancelled" })
  })

  it("retains a plain native error message and does not bypass hardware failure", async () => {
    const bio = makeBio({
      verifyIdentity: jest.fn().mockRejectedValue({ code: 1, message: "传感器暂不可用" }),
    })
    expect(await verify({ reason: "x", loader: async () => bio })).toEqual({
      kind: "error",
      message: "传感器暂不可用",
    })
  })

  it("uses an explicit Android attempt limit", async () => {
    const bio = makeBio()
    await verify({ reason: "x", maxAttempts: 3, loader: async () => bio })
    expect(bio.verifyIdentity).toHaveBeenCalledWith({ reason: "x", maxAttempts: 3 })
  })

  it("allows only one prompt at a time and releases its lock after cancellation", async () => {
    let finish!: () => void
    const bio = makeBio({
      verifyIdentity: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      ),
    })
    const first = verify({ reason: "x", loader: async () => bio })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(await verify({ reason: "y", loader: async () => bio })).toMatchObject({ kind: "error" })
    finish()
    await expect(first).resolves.toEqual({ kind: "verified" })
    expect(bio.verifyIdentity).toHaveBeenCalledTimes(1)
    const next = makeBio({ verifyIdentity: jest.fn().mockRejectedValue({ code: 16 }) })
    await expect(verify({ reason: "z", loader: async () => next })).resolves.toEqual({
      kind: "cancelled",
    })
    await expect(verify({ reason: "z", loader: async () => makeBio() })).resolves.toEqual({
      kind: "verified",
    })
  })

  it("shares the prompt slot with secure-storage operations and releases it on errors", async () => {
    await expect(
      withBiometricPromptLock(async () => {
        await expect(verify({ reason: "x", loader: async () => makeBio() })).resolves.toMatchObject(
          { kind: "error" }
        )
        throw new Error("secure storage failed")
      })
    ).rejects.toThrow("secure storage failed")
    await expect(verify({ reason: "x", loader: async () => makeBio() })).resolves.toEqual({
      kind: "verified",
    })
  })
})
