jest.mock("@/lib/claude/ipc", () => ({
  setOauthBearer: jest.fn(),
  restartSidecar: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

import { restartSidecar, setOauthBearer } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"

import { clearCredentialFromSidecar, syncCredentialToSidecar } from "./sidecar-sync"
import type { SubscriptionCredential } from "./types"

const mSetOauthBearer = setOauthBearer as jest.Mock
const mRestartSidecar = restartSidecar as jest.Mock
const mIsTauri = isTauri as jest.Mock

const sample: SubscriptionCredential = {
  accessToken: "oat01-test",
  refreshToken: "rt-test",
  expiresAtMs: Date.now() + 60 * 60 * 1000,
  mode: "subscription",
  storedAtMs: Date.now(),
}

beforeEach(() => {
  jest.resetAllMocks()
})

describe("syncCredentialToSidecar", () => {
  it("pushes the token and restarts the sidecar in Tauri mode", async () => {
    mIsTauri.mockReturnValue(true)
    mSetOauthBearer.mockResolvedValue(undefined)
    mRestartSidecar.mockResolvedValue(undefined)

    await syncCredentialToSidecar(sample)

    expect(mSetOauthBearer).toHaveBeenCalledWith("oat01-test")
    expect(mRestartSidecar).toHaveBeenCalledTimes(1)
    // Order matters: env first, then restart.
    const setOrder = mSetOauthBearer.mock.invocationCallOrder[0]
    const restartOrder = mRestartSidecar.mock.invocationCallOrder[0]
    expect(setOrder).toBeLessThan(restartOrder)
  })

  it("is a no-op outside Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    await syncCredentialToSidecar(sample)
    expect(mSetOauthBearer).not.toHaveBeenCalled()
    expect(mRestartSidecar).not.toHaveBeenCalled()
  })
})

describe("clearCredentialFromSidecar", () => {
  it("pushes null and restarts the sidecar in Tauri mode", async () => {
    mIsTauri.mockReturnValue(true)
    mSetOauthBearer.mockResolvedValue(undefined)
    mRestartSidecar.mockResolvedValue(undefined)

    await clearCredentialFromSidecar()

    expect(mSetOauthBearer).toHaveBeenCalledWith(null)
    expect(mRestartSidecar).toHaveBeenCalledTimes(1)
  })

  it("is a no-op outside Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    await clearCredentialFromSidecar()
    expect(mSetOauthBearer).not.toHaveBeenCalled()
    expect(mRestartSidecar).not.toHaveBeenCalled()
  })
})
