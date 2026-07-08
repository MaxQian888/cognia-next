/**
 * @jest-environment jsdom
 */
import { watchWorkspace, type WorkspaceFsChange } from "./workspace-watch"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(() => Promise.resolve()),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

beforeEach(() => {
  mockInvoke.mockClear()
  mockIsTauri.mockReturnValue(true)
})

function fireChange(watchId: string, detail: WorkspaceFsChange) {
  window.dispatchEvent(new CustomEvent(`plugin-fs-watch:${watchId}`, { detail }))
}

describe("watchWorkspace", () => {
  it("returns a no-op disposer off desktop", () => {
    mockIsTauri.mockReturnValue(false)
    const dispose = watchWorkspace("/repo", jest.fn())
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
  })

  it("starts a recursive watch and forwards in-root changes", () => {
    const onChange = jest.fn()
    watchWorkspace("/repo", onChange)
    const call = mockInvoke.mock.calls.find((c) => c[0] === "plugin_fs_watch")
    expect(call).toBeDefined()
    const watchId = (call?.[1] as { watchId: string }).watchId
    expect((call?.[1] as { path: string }).path).toBe("/repo")

    fireChange(watchId, { kind: "modify", path: "/repo/src/a.ts" })
    expect(onChange).toHaveBeenCalledWith({ kind: "modify", path: "/repo/src/a.ts" })
  })

  it("ignores changes outside the root (sibling-prefix guard)", () => {
    const onChange = jest.fn()
    watchWorkspace("/repo", onChange)
    const watchId = (
      mockInvoke.mock.calls.find((c) => c[0] === "plugin_fs_watch")?.[1] as { watchId: string }
    ).watchId
    fireChange(watchId, { kind: "modify", path: "/repo2/other.ts" })
    expect(onChange).not.toHaveBeenCalled()
  })

  it("disposing removes the listener and unwatches", () => {
    const onChange = jest.fn()
    const dispose = watchWorkspace("/repo", onChange)
    const watchId = (
      mockInvoke.mock.calls.find((c) => c[0] === "plugin_fs_watch")?.[1] as { watchId: string }
    ).watchId
    dispose()
    expect(mockInvoke).toHaveBeenCalledWith("plugin_fs_unwatch", { watchId })
    fireChange(watchId, { kind: "create", path: "/repo/new.ts" })
    expect(onChange).not.toHaveBeenCalled()
  })
})
