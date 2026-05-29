const isTauriMock = jest.fn()
const loadGitRepoMock = jest.fn()
const pickDirectoryMock = jest.fn()

jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))
jest.mock("@/lib/git/load", () => ({ loadGitRepo: (...a: unknown[]) => loadGitRepoMock(...a) }))
jest.mock("@/lib/files/file-bridge", () => ({
  pickDirectory: (...a: unknown[]) => pickDirectoryMock(...a),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { useGitRepo } from "./use-git-repo"
import { useGitStore } from "@/stores/git/git-store"

beforeEach(() => {
  isTauriMock.mockReset()
  loadGitRepoMock.mockReset().mockResolvedValue(undefined)
  pickDirectoryMock.mockReset()
  act(() => useGitStore.setState({ rootDir: null }))
})

describe("useGitRepo", () => {
  it("loads on mount when a repo is bound (desktop)", async () => {
    isTauriMock.mockReturnValue(true)
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    renderHook(() => useGitRepo())
    await waitFor(() => expect(loadGitRepoMock).toHaveBeenCalledWith("/repo"))
  })

  it("does not load on web", async () => {
    isTauriMock.mockReturnValue(false)
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    renderHook(() => useGitRepo())
    await Promise.resolve()
    expect(loadGitRepoMock).not.toHaveBeenCalled()
  })

  it("openFolder picks a directory and binds it", async () => {
    isTauriMock.mockReturnValue(true)
    pickDirectoryMock.mockResolvedValue("/picked")
    const { result } = renderHook(() => useGitRepo())
    await act(async () => {
      await result.current.openFolder()
    })
    expect(useGitStore.getState().rootDir).toBe("/picked")
  })

  it("openFolder ignores a cancelled picker", async () => {
    isTauriMock.mockReturnValue(true)
    pickDirectoryMock.mockResolvedValue(null)
    act(() => useGitStore.setState({ rootDir: "/keep" }))
    const { result } = renderHook(() => useGitRepo())
    await act(async () => {
      await result.current.openFolder()
    })
    expect(useGitStore.getState().rootDir).toBe("/keep")
  })

  it("refresh proxies to loadGitRepo for the bound path", async () => {
    isTauriMock.mockReturnValue(true)
    act(() => useGitStore.setState({ rootDir: "/repo" }))
    const { result } = renderHook(() => useGitRepo())
    loadGitRepoMock.mockClear()
    await act(async () => {
      await result.current.refresh()
    })
    expect(loadGitRepoMock).toHaveBeenCalledWith("/repo")
  })
})
