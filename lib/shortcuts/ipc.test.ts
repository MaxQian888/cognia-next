const invokeMock = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

let tauri = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
}))

import { getGlobalShortcutChords, listGlobalShortcuts } from "./ipc"

beforeEach(() => {
  jest.clearAllMocks()
  tauri = true
})

describe("listGlobalShortcuts", () => {
  it("returns the registry's rows verbatim", async () => {
    invokeMock.mockResolvedValue([
      { id: "selection.copy", chord: "alt+shift+1" },
      { id: "tray.show", chord: "ctrl+shift+space" },
    ])
    await expect(listGlobalShortcuts()).resolves.toEqual([
      { id: "selection.copy", chord: "alt+shift+1" },
      { id: "tray.show", chord: "ctrl+shift+space" },
    ])
    expect(invokeMock).toHaveBeenCalledWith("shortcut_list")
  })

  it("tolerates a null payload rather than throwing at the call site", async () => {
    invokeMock.mockResolvedValue(null)
    await expect(listGlobalShortcuts()).resolves.toEqual([])
  })

  it("never invokes off the desktop app", async () => {
    tauri = false
    await expect(listGlobalShortcuts()).resolves.toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe("getGlobalShortcutChords", () => {
  it("keys the rows by id", async () => {
    invokeMock.mockResolvedValue([
      { id: "selection.copy", chord: "alt+shift+1" },
      { id: "selection.speak", chord: "alt+shift+6" },
    ])
    await expect(getGlobalShortcutChords()).resolves.toEqual({
      "selection.copy": "alt+shift+1",
      "selection.speak": "alt+shift+6",
    })
  })

  it("is empty rather than undefined when nothing is bound", async () => {
    tauri = false
    await expect(getGlobalShortcutChords()).resolves.toEqual({})
  })
})
