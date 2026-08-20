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

import { __resetBootReattachForTests, bootReattachTerminals } from "./boot-reattach"

beforeEach(() => {
  __resetBootReattachForTests()
  mockChain = []
  mockRehydrate.mockClear()
  mockRehydrate.mockResolvedValue({ restored: 0, failed: 0 })
  restorePersistedLayout.mockClear()
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

  it("does not let a failed reattach escape into boot", async () => {
    mockChain = ["ws"]
    mockRehydrate.mockRejectedValue(new Error("host offline"))
    await expect(bootReattachTerminals()).resolves.toBeUndefined()
  })
})
