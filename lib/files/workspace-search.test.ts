import { transport } from "@/lib/tauri"
import { __resetWorkspaceSearchCache, searchWorkspace } from "./workspace-search"

beforeEach(() => {
  __resetWorkspaceSearchCache()
  jest.restoreAllMocks()
})

describe("searchWorkspace", () => {
  it("returns mapped entries", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce([
      {
        rel_path: "src/page.tsx",
        absolute_path: "/repo/src/page.tsx",
        is_dir: false,
        size: 1024,
        mtime_ms: 1_700_000_000_000,
      },
    ])
    const result = await searchWorkspace("/repo", "page", 10)
    expect(result).toEqual([
      {
        relPath: "src/page.tsx",
        absolutePath: "/repo/src/page.tsx",
        isDir: false,
        size: 1024,
        mtimeMs: 1_700_000_000_000,
      },
    ])
    expect(callSpy).toHaveBeenCalledWith("fs_search_workspace", {
      root: "/repo",
      query: "page",
      limit: 10,
    })
  })

  it("caches consecutive identical calls", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue([])
    await searchWorkspace("/repo", "x", 5)
    await searchWorkspace("/repo", "X", 5) // case-insensitive cache key
    expect(callSpy).toHaveBeenCalledTimes(1)
  })

  it("does not cache different queries", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue([])
    await searchWorkspace("/repo", "a", 5)
    await searchWorkspace("/repo", "b", 5)
    expect(callSpy).toHaveBeenCalledTimes(2)
  })

  it("propagates errors from the transport", async () => {
    jest.spyOn(transport, "call").mockRejectedValueOnce(new Error("root is not a directory"))
    await expect(searchWorkspace("/bogus", "", 5)).rejects.toThrow("root is not a directory")
  })
})
