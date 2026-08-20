/**
 * @jest-environment jsdom
 */

let mockChain: string[] = []
const mockRehydrate = jest.fn(async () => ({ restored: 0, failed: 0 }))
const restorePersistedLayout = jest.fn()

jest.mock("./pick-transport", () => ({
  selectTerminalTransportChain: () => mockChain,
}))

jest.mock("./rehydrate", () => ({
  rehydrateTerminals: () => mockRehydrate(),
}))

jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ restorePersistedLayout }) },
}))

let profileSyncSettled = false
const mockEnsureProfiles = jest.fn(
  () =>
    new Promise<void>((resolve) => {
      if (profileSyncSettled) resolve()
    })
)
jest.mock("./host-profiles", () => ({
  ensureTerminalHostProfilesSynced: () => mockEnsureProfiles(),
}))

import { __resetBootReattachForTests, bootReattachTerminals } from "./boot-reattach"

beforeEach(() => {
  __resetBootReattachForTests()
  mockChain = []
  mockRehydrate.mockClear()
  mockRehydrate.mockResolvedValue({ restored: 0, failed: 0 })
  restorePersistedLayout.mockClear()
  mockEnsureProfiles.mockClear()
  profileSyncSettled = true
})

describe("bootReattachTerminals", () => {
  // The whole point: a browser paired to a cognia-server has the same
  // surviving sessions the desktop does, and nothing used to go get them.
  it("reattaches over a remote transport", async () => {
    mockChain = ["ws", "webrtc"]
    await bootReattachTerminals()
    expect(mockRehydrate).toHaveBeenCalledTimes(1)
    // `rehydrateTerminals` restores the layout itself, after the surviving
    // sessions have registered — doing it here as well would validate the
    // saved tab metadata against an empty session map and discard it.
    expect(restorePersistedLayout).not.toHaveBeenCalled()
  })

  // `TerminalBridgeInitializer` already reattaches there, alongside the VS Code
  // bridge and the profile sync it must stay ordered with.
  it("leaves the local PTY to the desktop initializer", async () => {
    mockChain = ["tauri-channel"]
    await bootReattachTerminals()
    expect(mockRehydrate).not.toHaveBeenCalled()
    expect(restorePersistedLayout).not.toHaveBeenCalled()
  })

  it("drops the stale layout in web standalone, where nothing survived", async () => {
    mockChain = []
    await bootReattachTerminals()
    expect(mockRehydrate).not.toHaveBeenCalled()
    expect(restorePersistedLayout).toHaveBeenCalledTimes(1)
  })

  // Both dock slots mount, and reattaching one PTY twice would wire two
  // logical streams to a single session.
  it("runs once per page load however many callers there are", async () => {
    mockChain = ["ws"]
    await Promise.all([bootReattachTerminals(), bootReattachTerminals(), bootReattachTerminals()])
    await bootReattachTerminals()
    expect(mockRehydrate).toHaveBeenCalledTimes(1)
  })

  // Profiles are needed by the next *spawn*, not by reattaching — and the sync
  // waits on the settings store, which must never be able to hold the
  // reattach hostage. The spawn path awaits the same shared promise, so
  // nothing can outrun it.
  it("starts the profile sync without waiting for it", async () => {
    mockChain = ["ws"]
    profileSyncSettled = false
    await bootReattachTerminals()
    expect(mockEnsureProfiles).toHaveBeenCalledTimes(1)
    expect(mockRehydrate).toHaveBeenCalledTimes(1)
  })

  it("does not sync profiles when there is no host", async () => {
    mockChain = []
    await bootReattachTerminals()
    expect(mockEnsureProfiles).not.toHaveBeenCalled()
  })

  it("does not let a failed reattach escape into boot", async () => {
    mockChain = ["ws"]
    mockRehydrate.mockRejectedValue(new Error("host offline"))
    await expect(bootReattachTerminals()).resolves.toBeUndefined()
  })
})
