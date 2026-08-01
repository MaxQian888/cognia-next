/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import {
  GIT_BOUNDS,
  useGitBranchInfo,
  useGitBusy,
  useGitConflicts,
  useGitOp,
  useGitRootDir,
  useGitStatus,
  useGitStore,
} from "./git-store"
import type { GitConflict, GitDiff, GitStatus } from "@/types/git"

function mkDiff(path: string): GitDiff {
  return { path, oldContent: "", newContent: "", hunks: [], isBinary: false }
}

const sampleStatus: GitStatus = {
  branch: "main",
  upstream: "origin/main",
  ahead: 1,
  behind: 2,
  staged: [],
  changes: [],
  merge: [],
  isRebasing: false,
  isMerging: false,
}

beforeEach(() => {
  act(() => {
    useGitStore.setState({ rootDir: "__sentinel__" })
    useGitStore.getState().setRootDir(null) // forces a transient-state clear
    useGitStore.getState().reset()
    useGitStore.setState({ diffCache: {}, diffCacheOrder: [], commitDraft: {} })
  })
})

describe("git-store", () => {
  it("setRootDir clears transient state when path changes", () => {
    act(() => {
      useGitStore.getState().setStatus(sampleStatus)
      useGitStore.getState().setRootDir("/repo")
    })
    expect(useGitStore.getState().rootDir).toBe("/repo")
    expect(useGitStore.getState().status).toBeNull()
  })

  it("setRootDir is a no-op when unchanged", () => {
    act(() => useGitStore.getState().setRootDir("/repo"))
    act(() => {
      useGitStore.getState().setStatus(sampleStatus)
      useGitStore.getState().setRootDir("/repo") // same → must NOT clear status
    })
    expect(useGitStore.getState().status).toEqual(sampleStatus)
  })

  it("LRU-evicts the oldest diff past the cap", () => {
    act(() => {
      for (let i = 0; i < GIT_BOUNDS.diffCacheMax + 5; i++) {
        useGitStore.getState().cacheDiff(`k${i}`, mkDiff(`f${i}`))
      }
    })
    const { diffCache, diffCacheOrder } = useGitStore.getState()
    expect(diffCacheOrder.length).toBe(GIT_BOUNDS.diffCacheMax)
    expect(diffCache.k0).toBeUndefined()
    expect(diffCache[`k${GIT_BOUNDS.diffCacheMax + 4}`]).toBeDefined()
  })

  it("re-caching a key moves it to most-recent (no eviction)", () => {
    act(() => {
      useGitStore.getState().cacheDiff("a", mkDiff("a"))
      useGitStore.getState().cacheDiff("b", mkDiff("b"))
      useGitStore.getState().cacheDiff("a", mkDiff("a2"))
    })
    expect(useGitStore.getState().diffCacheOrder).toEqual(["b", "a"])
    expect(useGitStore.getState().getCachedDiff("a")?.newContent).toBe("")
  })

  it("invalidateDiff removes a cached entry", () => {
    act(() => {
      useGitStore.getState().cacheDiff("a", mkDiff("a"))
      useGitStore.getState().invalidateDiff("a")
    })
    expect(useGitStore.getState().getCachedDiff("a")).toBeUndefined()
  })

  it("invalidateDiff on a missing key is a no-op", () => {
    act(() => useGitStore.getState().cacheDiff("a", mkDiff("a")))
    act(() => useGitStore.getState().invalidateDiff("missing"))
    expect(useGitStore.getState().getCachedDiff("a")).toBeDefined()
  })

  it("branch-info selector falls back to nulls/zeros without status", () => {
    act(() => useGitStore.getState().setStatus(null))
    expect(renderHook(() => useGitBranchInfo()).result.current).toEqual({
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
    })
  })

  it("toggleGroup flips expansion", () => {
    const before = useGitStore.getState().expandedGroups.staged
    act(() => useGitStore.getState().toggleGroup("staged"))
    expect(useGitStore.getState().expandedGroups.staged).toBe(!before)
  })

  it("commit drafts are isolated per repo", () => {
    act(() => {
      useGitStore.getState().setCommitDraft("/a", "msg-a")
      useGitStore.getState().setCommitDraft("/b", "msg-b")
    })
    expect(useGitStore.getState().commitDraft["/a"]).toBe("msg-a")
    expect(useGitStore.getState().commitDraft["/b"]).toBe("msg-b")
  })

  it("op flags toggle and errors set/clear", () => {
    act(() => useGitStore.getState().setOp("push", true))
    expect(useGitStore.getState().ops.push).toBe(true)
    act(() => useGitStore.getState().setError("push", "boom"))
    expect(useGitStore.getState().lastError).toEqual({ op: "push", message: "boom" })
    act(() => useGitStore.getState().clearError())
    expect(useGitStore.getState().lastError).toBeNull()
  })

  it("tracks repository load errors independently from mutation errors", () => {
    act(() => {
      useGitStore.getState().setError("push", "push failed")
      useGitStore.getState().setLoadError("repository unavailable")
    })
    expect(useGitStore.getState().lastError).toEqual({ op: "push", message: "push failed" })
    expect(useGitStore.getState().loadError).toBe("repository unavailable")
    act(() => useGitStore.getState().setLoadError(null))
    expect(useGitStore.getState().loadError).toBeNull()
  })

  it("selectFile and selectCommit are mutually exclusive", () => {
    act(() => useGitStore.getState().selectFile("a.ts", true))
    expect(useGitStore.getState().selectedPath).toBe("a.ts")
    expect(useGitStore.getState().selectedCommit).toBeNull()
    act(() => useGitStore.getState().selectCommit("sha1"))
    expect(useGitStore.getState().selectedCommit).toBe("sha1")
    expect(useGitStore.getState().selectedPath).toBeNull()
  })

  it("setTimeline writes the scoped list", () => {
    act(() => useGitStore.getState().setTimeline("repo", [{ hash: "h" } as never]))
    expect(useGitStore.getState().timelineRepo).toHaveLength(1)
    act(() => useGitStore.getState().setTimeline("file", [{ hash: "f" } as never]))
    expect(useGitStore.getState().timelineFile).toHaveLength(1)
  })

  it("plain setters update their slices", () => {
    const conflicts: GitConflict[] = [{ path: "c", ours: "o", theirs: "t", base: null }]
    act(() => {
      const s = useGitStore.getState()
      s.setRepoState({
        isRepo: true,
        rootDir: "/r",
        detachedHead: true,
        operationInProgress: "merge",
      })
      s.setLoadingStatus(true)
      s.setBranches([
        { name: "main", isCurrent: true, isRemote: false, upstream: null, ahead: 0, behind: 0 },
      ])
      s.setStashes([{ index: 0, message: "m", branch: "main" }])
      s.setConflicts(conflicts)
      s.setActiveConflict("c")
      s.setTimelineScope("file")
    })
    const s = useGitStore.getState()
    expect(s.repoState?.detachedHead).toBe(true)
    expect(s.loadingStatus).toBe(true)
    expect(s.branches).toHaveLength(1)
    expect(s.stashes).toHaveLength(1)
    expect(s.conflicts).toHaveLength(1)
    expect(s.activeConflictPath).toBe("c")
    expect(s.timelineScope).toBe("file")
  })

  it("selector hooks read the store", () => {
    act(() => {
      useGitStore.setState({ rootDir: "/r" })
      useGitStore.getState().setStatus(sampleStatus)
      useGitStore.getState().setConflicts([{ path: "c", ours: "", theirs: "", base: null }])
      useGitStore.getState().setOp("push", true)
    })
    expect(renderHook(() => useGitRootDir()).result.current).toBe("/r")
    expect(renderHook(() => useGitStatus()).result.current).toEqual(sampleStatus)
    expect(renderHook(() => useGitConflicts()).result.current).toHaveLength(1)
    expect(renderHook(() => useGitOp("push")).result.current).toBe(true)
    expect(renderHook(() => useGitBranchInfo()).result.current).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
    })
    expect(renderHook(() => useGitBusy()).result.current).toBe(true)
  })
})
