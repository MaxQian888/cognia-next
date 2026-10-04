/** @jest-environment jsdom */
import {
  enrollNativeBiometric,
  readNativeBiometricSecret,
  removeNativeBiometricSecret,
} from "./native-biometric"

let mobile = true
jest.mock("@/lib/capacitor/_shared", () => ({
  isMobile: () => mobile,
  makeDefaultLoader: () => async () => {
    throw new Error("missing bridge")
  },
}))

const prompt = { title: "Unlock", reason: "Unlock account", negativeButtonText: "Cancel" }
const accountId = "account-one"
const keyId = "cognia.account-biometric.v1:account-one:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
const secret = `biometric:${"ab".repeat(32)}`
function plugin() {
  let value = ""
  return {
    isAvailable: jest.fn(async () => ({ isAvailable: true, strongBiometryIsAvailable: true })),
    setData: jest.fn(async (options: { value: string }) => {
      value = options.value
    }),
    getSecureData: jest.fn(async () => ({ value })),
    deleteData: jest.fn(async () => {}),
  }
}
beforeEach(() => {
  mobile = true
})

it("protects a random account secret and proves secure retrieval before committing enrollment", async () => {
  const native = plugin()
  const commit = jest.fn(async () => {})
  expect(
    await enrollNativeBiometric({ accountId, prompt, commit, loader: async () => native })
  ).toEqual({ ok: true })
  expect(native.setData).toHaveBeenCalledWith(
    expect.objectContaining({ accessControl: 1, authValidityDuration: 0 })
  )
  const stored = native.setData.mock.calls[0][0]
  expect(stored.value).toMatch(/^biometric:[a-f0-9]{64}$/)
  expect(native.getSecureData).toHaveBeenCalledWith(
    expect.objectContaining({ fallbackTitle: "", reason: prompt.reason })
  )
  expect(commit).toHaveBeenCalledWith(stored.value, expect.stringContaining(`:${accountId}:`))
})

it("does not store or enroll for weak-only biometrics", async () => {
  const native = plugin()
  native.isAvailable.mockResolvedValue({ isAvailable: true, strongBiometryIsAvailable: false })
  const commit = jest.fn()
  expect(
    await enrollNativeBiometric({ accountId, prompt, commit, loader: async () => native })
  ).toEqual({ ok: false, reason: "unavailable" })
  expect(native.setData).not.toHaveBeenCalled()
  expect(commit).not.toHaveBeenCalled()
})

it("removes a candidate key after cancellation without committing", async () => {
  const native = plugin()
  native.getSecureData.mockRejectedValueOnce({ code: "16", message: "用户取消" })
  const commit = jest.fn()
  expect(
    await enrollNativeBiometric({ accountId, prompt, commit, loader: async () => native })
  ).toEqual({ ok: false, reason: "cancelled" })
  expect(commit).not.toHaveBeenCalled()
  expect(native.deleteData).toHaveBeenCalledTimes(1)
})

it("cleans candidate storage when committing the vault wrap fails", async () => {
  const native = plugin()
  expect(
    await enrollNativeBiometric({
      accountId,
      prompt,
      commit: async () => {
        throw new Error("bad password")
      },
      loader: async () => native,
    })
  ).toEqual({ ok: false, reason: "failed" })
  expect(native.deleteData).toHaveBeenCalledTimes(1)
})

it("reads the same secret only through authenticated storage", async () => {
  const native = plugin()
  native.getSecureData.mockResolvedValue({ value: secret })
  expect(
    await readNativeBiometricSecret({ accountId, keyId, prompt, loader: async () => native })
  ).toEqual({ ok: true, value: secret })
  expect(native.getSecureData).toHaveBeenCalledWith(expect.objectContaining({ key: keyId }))
})

it.each([
  { code: "21", message: "No protected data found for key" },
  { code: "0", message: "Biometric enrollment changed" },
])("requires password recovery for invalidated storage: $message", async (error) => {
  const native = plugin()
  native.getSecureData.mockRejectedValue(error)
  expect(
    await readNativeBiometricSecret({ accountId, keyId, prompt, loader: async () => native })
  ).toEqual({ ok: false, reason: "unavailable" })
})

it.each([2, 4, 11, 16, 21])("does not return a secret after native failure %s", async (code) => {
  const native = plugin()
  native.getSecureData.mockRejectedValue({ code, message: "认证失败" })
  expect(
    await readNativeBiometricSecret({ accountId, keyId, prompt, loader: async () => native })
  ).toMatchObject({ ok: false })
})

it("rejects another account's key before reaching the bridge", async () => {
  const loader = jest.fn()
  expect(await readNativeBiometricSecret({ accountId: "other", keyId, prompt, loader })).toEqual({
    ok: false,
    reason: "unavailable",
  })
  await expect(removeNativeBiometricSecret("other", keyId, loader)).rejects.toThrow()
  expect(loader).not.toHaveBeenCalled()
})

it("rejects malformed returned key material", async () => {
  const native = plugin()
  native.getSecureData.mockResolvedValue({ value: "verified" })
  expect(
    await readNativeBiometricSecret({ accountId, keyId, prompt, loader: async () => native })
  ).toEqual({ ok: false, reason: "failed" })
})

it("does not use web storage or load a native plugin off mobile", async () => {
  mobile = false
  const loader = jest.fn()
  expect(await enrollNativeBiometric({ accountId, prompt, commit: jest.fn(), loader })).toEqual({
    ok: false,
    reason: "unavailable",
  })
  expect(loader).not.toHaveBeenCalled()
})

it("cleans the candidate and never commits a result arriving after cancellation", async () => {
  const native = plugin()
  const controller = new AbortController()
  native.getSecureData.mockImplementation(async () => {
    controller.abort()
    return { value: native.setData.mock.calls[0][0].value }
  })
  const commit = jest.fn()
  expect(
    await enrollNativeBiometric({
      accountId,
      prompt,
      commit,
      signal: controller.signal,
      loader: async () => native,
    })
  ).toEqual({ ok: false, reason: "cancelled" })
  expect(commit).not.toHaveBeenCalled()
  expect(native.deleteData).toHaveBeenCalledTimes(1)
})

it("discards a valid secret if its caller was cancelled during the prompt", async () => {
  const native = plugin()
  const controller = new AbortController()
  native.getSecureData.mockImplementation(async () => {
    controller.abort()
    return { value: secret }
  })
  expect(
    await readNativeBiometricSecret({
      accountId,
      keyId,
      prompt,
      signal: controller.signal,
      loader: async () => native,
    })
  ).toEqual({ ok: false, reason: "cancelled" })
})
