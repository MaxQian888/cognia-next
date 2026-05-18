jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

jest.mock("../core/transport", () => ({
  setActiveAccount: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { setActiveAccount } from "../core/transport"
import { activateAnthropicAccount, signOutAnthropic } from "./sidecar-sync"

const mIsTauri = isTauri as jest.Mock
const mSetActive = setActiveAccount as jest.Mock

beforeEach(() => {
  jest.resetAllMocks()
})

describe("activateAnthropicAccount", () => {
  it("calls subscription_set_active with provider+accountId in Tauri mode", async () => {
    mIsTauri.mockReturnValue(true)
    mSetActive.mockResolvedValue(undefined)
    await activateAnthropicAccount("0193c2b0-0000-7000-8000-000000000001")
    expect(mSetActive).toHaveBeenCalledWith("anthropic", "0193c2b0-0000-7000-8000-000000000001")
  })

  it("is a no-op outside Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    await activateAnthropicAccount("any-id")
    expect(mSetActive).not.toHaveBeenCalled()
  })
})

describe("signOutAnthropic", () => {
  it("clears the active pointer in Tauri mode", async () => {
    mIsTauri.mockReturnValue(true)
    mSetActive.mockResolvedValue(undefined)
    await signOutAnthropic()
    expect(mSetActive).toHaveBeenCalledWith("anthropic", null)
  })

  it("is a no-op outside Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    await signOutAnthropic()
    expect(mSetActive).not.toHaveBeenCalled()
  })
})
