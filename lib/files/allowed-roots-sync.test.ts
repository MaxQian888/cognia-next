const mInvoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => mInvoke(...a) }))

const mIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mIsTauri() }))

const mProjects: { projects: unknown[] } = { projects: [] }
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => mProjects },
}))

import { syncAllowedRootsToRust, registerDialogPathInRust } from "./allowed-roots-sync"

beforeEach(() => {
  jest.clearAllMocks()
  mIsTauri.mockReturnValue(true)
  mProjects.projects = []
  mInvoke.mockResolvedValue(undefined)
})

describe("syncAllowedRootsToRust", () => {
  it("pushes the de-duplicated union of all project roots", async () => {
    mProjects.projects = [
      { roots: [{ path: "/a", isPrimary: true }, { path: "/shared" }] },
      { roots: [{ path: "/b" }, { path: "/shared" }] },
    ]
    await syncAllowedRootsToRust()
    expect(mInvoke).toHaveBeenCalledTimes(1)
    const [cmd, args] = mInvoke.mock.calls[0]
    expect(cmd).toBe("fs_set_allowed_roots")
    expect([...(args as { paths: string[] }).paths].sort()).toEqual(["/a", "/b", "/shared"])
  })

  it("is a no-op on web (not Tauri)", async () => {
    mIsTauri.mockReturnValue(false)
    await syncAllowedRootsToRust()
    expect(mInvoke).not.toHaveBeenCalled()
  })

  it("skips the invoke when there are no roots", async () => {
    mProjects.projects = [{ roots: [] }]
    await syncAllowedRootsToRust()
    expect(mInvoke).not.toHaveBeenCalled()
  })

  it("never throws when the invoke rejects", async () => {
    mProjects.projects = [{ roots: [{ path: "/a" }] }]
    mInvoke.mockRejectedValue(new Error("boom"))
    await expect(syncAllowedRootsToRust()).resolves.toBeUndefined()
  })
})

describe("registerDialogPathInRust", () => {
  it("forwards the chosen path to fs_allow_dialog_path", async () => {
    await registerDialogPathInRust("/home/me/Documents/export.json")
    expect(mInvoke).toHaveBeenCalledWith("fs_allow_dialog_path", {
      path: "/home/me/Documents/export.json",
    })
  })

  it("is a no-op on web and for an empty path", async () => {
    mIsTauri.mockReturnValue(false)
    await registerDialogPathInRust("/x")
    mIsTauri.mockReturnValue(true)
    await registerDialogPathInRust("")
    expect(mInvoke).not.toHaveBeenCalled()
  })

  it("never throws when the invoke rejects", async () => {
    mInvoke.mockRejectedValue(new Error("boom"))
    await expect(registerDialogPathInRust("/x")).resolves.toBeUndefined()
  })
})
