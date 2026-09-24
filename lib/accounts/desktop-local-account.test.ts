import type { LocalAccountRecord } from "./account-types"
import {
  desktopLocalAccountPassword,
  clearDesktopLocalAccountPassword,
  clearDeviceUnlockSecret,
  deviceUnlockSecretRef,
  isDesktopLocalAccountEnabled,
  isDevDesktopWorkspace,
  isDeviceManagedAccount,
  isDeviceUnlockSupported,
  isRememberedOnDevice,
  readDeviceUnlockSecret,
  saveDeviceUnlockSecret,
  unlocksWithoutPrompt,
  DESKTOP_LOCAL_ACCOUNT_ID,
  saveDesktopLocalAccountRecoveryKey,
  readDesktopLocalAccountRecoveryKey,
  clearDesktopLocalAccountRecoveryKey,
} from "./desktop-local-account"

let mockTauri = true
const mockGet = jest.fn()
const mockSet = jest.fn()
const mockClear = jest.fn()
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => mockTauri }))
jest.mock("@/lib/keyring", () => ({
  getSecret: (...args: unknown[]) => mockGet(...args),
  setSecret: (...args: unknown[]) => mockSet(...args),
  clearSecret: (...args: unknown[]) => mockClear(...args),
}))

const ORIGINAL_NODE_ENV = process.env.NODE_ENV

function setNodeEnv(value: string | undefined): void {
  Object.defineProperty(process.env, "NODE_ENV", { value, configurable: true })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockTauri = true
  mockGet.mockResolvedValue(null)
  mockSet.mockResolvedValue(undefined)
  delete process.env.NEXT_PUBLIC_ACCOUNT_GATE
})

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV)
  delete (globalThis as { window?: unknown }).window
})

it("only enables the default profile on desktop unless the gate is forced", () => {
  expect(isDesktopLocalAccountEnabled()).toBe(true)
  process.env.NEXT_PUBLIC_ACCOUNT_GATE = "1"
  expect(isDesktopLocalAccountEnabled()).toBe(false)
  delete process.env.NEXT_PUBLIC_ACCOUNT_GATE
  mockTauri = false
  expect(isDesktopLocalAccountEnabled()).toBe(false)
})

it("recognizes explicit device metadata only on the reserved profile", () => {
  expect(isDeviceManagedAccount(undefined)).toBe(false)
  expect(isDeviceManagedAccount({ id: DESKTOP_LOCAL_ACCOUNT_ID } as LocalAccountRecord)).toBe(false)
  expect(
    isDeviceManagedAccount({ id: "acct_other", protection: "device" } as LocalAccountRecord)
  ).toBe(false)
  expect(
    isDeviceManagedAccount({
      id: DESKTOP_LOCAL_ACCOUNT_ID,
      protection: "device",
    } as LocalAccountRecord)
  ).toBe(true)
})

it("persists a random credential before returning it for fresh provisioning", async () => {
  const secret = await desktopLocalAccountPassword(true)
  expect(secret).toMatch(/^[a-f0-9]{64}$/)
  expect(mockSet).toHaveBeenCalledWith(expect.anything(), secret)
})

it("reuses the native credential and never replaces it on resume", async () => {
  expect(await desktopLocalAccountPassword()).toBeNull()
  expect(mockSet).not.toHaveBeenCalled()
  mockGet.mockResolvedValue("existing")
  expect(await desktopLocalAccountPassword(true)).toBe("existing")
  expect(mockSet).not.toHaveBeenCalled()
})

it("refuses provisioning when native persistence fails", async () => {
  mockSet.mockRejectedValue(new Error("denied"))
  await expect(desktopLocalAccountPassword(true)).rejects.toThrow("denied")
})

it("never stores desktop credentials in a browser fallback", async () => {
  mockTauri = false
  expect(await desktopLocalAccountPassword(true)).toBeNull()
  await clearDesktopLocalAccountPassword()
  expect(mockGet).not.toHaveBeenCalled()
  expect(mockSet).not.toHaveBeenCalled()
  expect(mockClear).not.toHaveBeenCalled()
})

it("removes the old managed credential after password protection is enabled", async () => {
  await clearDesktopLocalAccountPassword()
  expect(mockClear).toHaveBeenCalledWith(
    {
      namespace: "desktop-local-account",
      key: DESKTOP_LOCAL_ACCOUNT_ID,
    },
    { strict: true }
  )
})

it("never treats native read failure as permission to replace the secret", async () => {
  mockGet.mockRejectedValueOnce(new Error("read denied"))
  await expect(desktopLocalAccountPassword(true)).rejects.toThrow("read denied")
  expect(mockGet).toHaveBeenCalledWith(expect.anything(), { strict: true })
  expect(mockSet).not.toHaveBeenCalled()
})

it("preserves recovery in native storage until explicit handover", async () => {
  await saveDesktopLocalAccountRecoveryKey("recovery")
  expect(mockSet).toHaveBeenCalledWith(
    { namespace: "desktop-local-account", key: `${DESKTOP_LOCAL_ACCOUNT_ID}:recovery` },
    "recovery"
  )
  mockGet.mockResolvedValueOnce("recovery")
  expect(await readDesktopLocalAccountRecoveryKey()).toBe("recovery")
  await clearDesktopLocalAccountRecoveryKey()
  expect(mockClear).toHaveBeenCalledWith(
    expect.objectContaining({ key: `${DESKTOP_LOCAL_ACCOUNT_ID}:recovery` }),
    { strict: true }
  )
})

it("refuses recovery storage outside desktop", async () => {
  mockTauri = false
  await expect(saveDesktopLocalAccountRecoveryKey("recovery")).rejects.toThrow(
    "desktop credential store"
  )
  expect(await readDesktopLocalAccountRecoveryKey()).toBeNull()
  await clearDesktopLocalAccountRecoveryKey()
  expect(mockSet).not.toHaveBeenCalled()
  expect(mockClear).not.toHaveBeenCalled()
})

describe("per-profile device unlock", () => {
  const remembered = { id: "acct_mine", rememberOnDevice: true } as LocalAccountRecord
  const device = { id: DESKTOP_LOCAL_ACCOUNT_ID, protection: "device" } as LocalAccountRecord

  it("keeps the reserved workspace on the slot it has always used", () => {
    expect(deviceUnlockSecretRef(DESKTOP_LOCAL_ACCOUNT_ID)).toEqual({
      namespace: "desktop-local-account",
      key: DESKTOP_LOCAL_ACCOUNT_ID,
    })
    expect(deviceUnlockSecretRef("acct_mine")).toEqual({
      namespace: "desktop-local-account",
      key: "acct_mine",
    })
  })

  it("stores, reads and clears one profile's secret strictly", async () => {
    await saveDeviceUnlockSecret("acct_mine", "hunter22")
    expect(mockSet).toHaveBeenCalledWith(deviceUnlockSecretRef("acct_mine"), "hunter22")
    mockGet.mockResolvedValueOnce("hunter22")
    expect(await readDeviceUnlockSecret("acct_mine")).toBe("hunter22")
    expect(mockGet).toHaveBeenCalledWith(deviceUnlockSecretRef("acct_mine"), { strict: true })
    await clearDeviceUnlockSecret("acct_mine")
    expect(mockClear).toHaveBeenCalledWith(deviceUnlockSecretRef("acct_mine"), { strict: true })
  })

  it("propagates a store that cannot be read instead of reading it as absent", async () => {
    mockGet.mockRejectedValueOnce(new Error("SECRET_STORE_LOCKED"))
    await expect(readDeviceUnlockSecret("acct_mine")).rejects.toThrow("SECRET_STORE_LOCKED")
  })

  it("refuses to store an empty secret", async () => {
    await expect(saveDeviceUnlockSecret("acct_mine", "")).rejects.toThrow("cannot be empty")
    expect(mockSet).not.toHaveBeenCalled()
  })

  it("never keeps a secret outside the desktop shell", async () => {
    mockTauri = false
    await expect(saveDeviceUnlockSecret("acct_mine", "hunter22")).rejects.toThrow(
      "desktop credential store"
    )
    expect(await readDeviceUnlockSecret("acct_mine")).toBeNull()
    await clearDeviceUnlockSecret("acct_mine")
    expect(mockGet).not.toHaveBeenCalled()
    expect(mockClear).not.toHaveBeenCalled()
  })

  it("recognizes a remembered password profile, never the device workspace", () => {
    expect(isRememberedOnDevice(remembered)).toBe(true)
    expect(isRememberedOnDevice({ id: "acct_mine" } as LocalAccountRecord)).toBe(false)
    expect(isRememberedOnDevice({ ...device, rememberOnDevice: true })).toBe(false)
    expect(isRememberedOnDevice(null)).toBe(false)
  })

  it("says which profiles open without a prompt, and only on the desktop", () => {
    expect(unlocksWithoutPrompt(remembered)).toBe(true)
    expect(unlocksWithoutPrompt(device)).toBe(true)
    expect(unlocksWithoutPrompt({ id: "acct_mine" } as LocalAccountRecord)).toBe(false)
    expect(unlocksWithoutPrompt(undefined)).toBe(false)
    mockTauri = false
    expect(unlocksWithoutPrompt(remembered)).toBe(false)
    expect(unlocksWithoutPrompt(device)).toBe(false)
  })

  it("turns every no-prompt path off when the real gate is forced", () => {
    process.env.NEXT_PUBLIC_ACCOUNT_GATE = "1"
    expect(isDeviceUnlockSupported()).toBe(false)
    expect(unlocksWithoutPrompt(remembered)).toBe(false)
    expect(unlocksWithoutPrompt(device)).toBe(false)
  })
})

describe("isDevDesktopWorkspace", () => {
  // `isDevLocalAccountEnabled` needs a window; the node env has none.
  function withWindow(): void {
    ;(globalThis as { window?: unknown }).window = {}
  }

  it("is the reserved workspace under `pnpm tauri dev`", () => {
    withWindow()
    setNodeEnv("development")
    expect(isDevDesktopWorkspace(DESKTOP_LOCAL_ACCOUNT_ID)).toBe(true)
  })

  it("is never a profile created by hand", () => {
    withWindow()
    setNodeEnv("development")
    expect(isDevDesktopWorkspace("acct_mine")).toBe(false)
    expect(isDevDesktopWorkspace(null)).toBe(false)
  })

  it("is off in a release build and outside the desktop shell", () => {
    withWindow()
    setNodeEnv("production")
    expect(isDevDesktopWorkspace(DESKTOP_LOCAL_ACCOUNT_ID)).toBe(false)
    setNodeEnv("development")
    mockTauri = false
    expect(isDevDesktopWorkspace(DESKTOP_LOCAL_ACCOUNT_ID)).toBe(false)
  })

  it("is off when the real gate is forced", () => {
    withWindow()
    setNodeEnv("development")
    process.env.NEXT_PUBLIC_ACCOUNT_GATE = "1"
    expect(isDevDesktopWorkspace(DESKTOP_LOCAL_ACCOUNT_ID)).toBe(false)
  })
})
