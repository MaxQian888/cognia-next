/** @jest-environment jsdom */

const detectPlatform = jest.fn(() => "tauri")
jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => detectPlatform(),
}))

const getState = jest.fn(() => ({ activeAccountId: "acct_1" }) as { activeAccountId: unknown })
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => getState() },
}))

import { getLocalAccountId } from "./runner-owner"

beforeEach(() => {
  detectPlatform.mockReturnValue("tauri")
  getState.mockReturnValue({ activeAccountId: "acct_1" })
})

describe("getLocalAccountId", () => {
  it("combines the host kind and the account", async () => {
    expect(await getLocalAccountId()).toBe("tauri:acct_1")
  })

  it("is stable within one shell and account, so a remount resumes its own work", async () => {
    expect(await getLocalAccountId()).toBe(await getLocalAccountId())
  })

  it("differs across shells, so two runners never re-claim each other's lease", async () => {
    const desktop = await getLocalAccountId()
    detectPlatform.mockReturnValue("web")
    expect(await getLocalAccountId()).not.toBe(desktop)
  })

  it("differs across accounts", async () => {
    const first = await getLocalAccountId()
    getState.mockReturnValue({ activeAccountId: "acct_2" })
    expect(await getLocalAccountId()).not.toBe(first)
  })

  it("marks an unbound shell rather than colliding on an empty id", async () => {
    getState.mockReturnValue({ activeAccountId: null })
    expect(await getLocalAccountId()).toBe("tauri:unbound")
  })

  it("survives a store that cannot be read", async () => {
    getState.mockImplementation(() => {
      throw new Error("store not ready")
    })
    expect(await getLocalAccountId()).toBe("tauri:unbound")
  })
})
