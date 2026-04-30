import { invoke } from "@tauri-apps/api/core"
import { __resetWorkspaceSearchCache, searchWorkspace } from "./workspace-search"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  __resetWorkspaceSearchCache()
  mockedInvoke.mockReset()
})

describe("searchWorkspace", () => {
  it("returns mapped entries", async () => {
    mockedInvoke.mockResolvedValueOnce([
      {
        rel_path: "src/page.tsx",
        absolute_path: "/repo/src/page.tsx",
        is_dir: false,
        size: 1024,
      },
    ])
    const result = await searchWorkspace("/repo", "page", 10)
    expect(result).toEqual([
      {
        relPath: "src/page.tsx",
        absolutePath: "/repo/src/page.tsx",
        isDir: false,
        size: 1024,
      },
    ])
    expect(mockedInvoke).toHaveBeenCalledWith("fs_search_workspace", {
      root: "/repo",
      query: "page",
      limit: 10,
    })
  })

  it("caches consecutive identical calls", async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await searchWorkspace("/repo", "x", 5)
    await searchWorkspace("/repo", "X", 5) // case-insensitive cache key
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
  })

  it("does not cache different queries", async () => {
    mockedInvoke.mockResolvedValueOnce([])
    mockedInvoke.mockResolvedValueOnce([])
    await searchWorkspace("/repo", "a", 5)
    await searchWorkspace("/repo", "b", 5)
    expect(mockedInvoke).toHaveBeenCalledTimes(2)
  })

  it("propagates errors from the Tauri side", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("root is not a directory"))
    await expect(searchWorkspace("/bogus", "", 5)).rejects.toThrow("root is not a directory")
  })
})
