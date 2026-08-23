/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import {
  isUniqueHunk,
  reviewFileKey,
  reviewHunkKey,
  useReviewWorkspace,
} from "./use-review-workspace"
import { useDiffReviewStore } from "@/stores/git/diff-review-store"
import type { PullRequestProvider, PullRequestRef, ReviewFeedbackBundle } from "@/types/review"

const listMock = jest.fn()
const loadMock = jest.fn()
jest.mock("@/lib/review/scope", () => ({
  listReviewScopeFiles: (...args: unknown[]) => listMock(...args),
  loadReviewScopeFile: (...args: unknown[]) => loadMock(...args),
}))

const gitStatusMock = jest.fn()
jest.mock("@/lib/git/commands", () => ({
  gitStatus: (...args: unknown[]) => gitStatusMock(...args),
}))

function pr(repository: string, number: number): PullRequestRef {
  return {
    provider: "github",
    repository,
    number,
    url: `https://x/${number}`,
    headRef: "feature",
    baseRef: "main",
    title: "T",
    state: "open",
  }
}

let published: Array<[PullRequestRef, ReviewFeedbackBundle]> = []
function provider(overrides: Partial<PullRequestProvider> = {}): PullRequestProvider {
  return {
    id: "test",
    getAuthenticationState: async () => "authenticated",
    findForBranch: async (root) => pr(root, root === "/a" ? 1 : 2),
    push: async () => undefined,
    create: async () => pr("/a", 1),
    publishFeedback: async (pullRequest, bundle) => {
      published.push([pullRequest, bundle])
    },
    ...overrides,
  }
}

function ref(repositoryRoot: string, path: string) {
  return { repositoryRoot, path, source: "uncommitted" as const, reviewKey: path }
}

function hunk(hunkHash = "h1") {
  return { index: 0, hunkHash, header: "@@ -1 +1 @@", side: "after" as const, line: 1 }
}

function setup(options: Partial<Parameters<typeof useReviewWorkspace>[0]> = {}) {
  return renderHook(() =>
    useReviewWorkspace({
      rootDir: "/a",
      repositoryRoots: ["/a", "/b"],
      provider: provider(),
      open: true,
      ...options,
    })
  )
}

beforeEach(() => {
  published = []
  listMock.mockReset().mockResolvedValue({ files: [ref("/a", "x.ts")], unavailable: [] })
  loadMock
    .mockReset()
    .mockImplementation(async (_r: unknown, r: { path: string }) => ({ ...r, hunks: [hunk()] }))
  gitStatusMock.mockReset().mockResolvedValue({ branch: "feature" })
  useDiffReviewStore.setState({ decisions: {}, order: [] })
})

describe("keys", () => {
  it("separates the same path in two repositories", () => {
    expect(reviewFileKey(ref("/a", "x.ts"))).not.toBe(reviewFileKey(ref("/b", "x.ts")))
  })

  it("separates the staged and unstaged views of one file", () => {
    expect(reviewFileKey({ ...ref("/a", "x.ts"), staged: true })).not.toBe(
      reviewFileKey({ ...ref("/a", "x.ts"), staged: false })
    )
  })

  it("keys a hunk by content hash and index", () => {
    const file = ref("/a", "x.ts")
    expect(reviewHunkKey(file, hunk("h1"))).not.toBe(reviewHunkKey(file, hunk("h2")))
  })
})

describe("isUniqueHunk", () => {
  /** A duplicated hash cannot be anchored — `remapReviewComment` calls it stale. */
  it("rejects a hash that appears more than once in the file", () => {
    const hunks = [hunk("dup"), { ...hunk("dup"), index: 1 }]
    expect(isUniqueHunk(hunks, hunks[0])).toBe(false)
    expect(isUniqueHunk([hunk("only")], hunk("only"))).toBe(true)
  })
})

describe("per-repository refs", () => {
  it("carries each root's own refs into the scope request", async () => {
    const { result } = setup()
    act(() => result.current.setRootRefs("/a", { baseRef: "main", targetRef: "fa" }))
    act(() => result.current.setRootRefs("/b", { baseRef: "develop", targetRef: "fb" }))
    await act(async () => {
      await result.current.loadScope()
    })

    const [request] = listMock.mock.calls[0]
    expect(request.refsByRoot["/a"]).toMatchObject({ baseRef: "main", targetRef: "fa" })
    expect(request.refsByRoot["/b"]).toMatchObject({ baseRef: "develop", targetRef: "fb" })
  })

  /**
   * The panel supplies one entry — the root the active task run wrote in. Other
   * roots get no run, and the scope collector says so by name.
   */
  it("seeds a root's last-turn run from the supplied map", () => {
    const { result } = setup({ lastTurnRunIdByRoot: { "/b": "run-b" } })
    expect(result.current.rootState("/b").refs.lastTurnRunId).toBe("run-b")
    expect(result.current.rootState("/a").refs.lastTurnRunId).toBeUndefined()
  })

  it("only asks about the roots that are still selected", async () => {
    const { result } = setup()
    act(() => result.current.toggleRoot("/b", false))
    await act(async () => {
      await result.current.loadScope()
    })
    expect(listMock.mock.calls[0][0].repositoryRoots).toEqual(["/a"])
  })
})

describe("loading", () => {
  it("lists without loading any file's hunks", async () => {
    const { result } = setup()
    await act(async () => {
      await result.current.loadScope()
    })
    expect(result.current.files).toHaveLength(1)
    expect(loadMock).not.toHaveBeenCalled()
  })

  /** A stored comment reaches the bundle only through its hunks. */
  it("loads a file up front when it already carries a stored comment", async () => {
    useDiffReviewStore.getState().setComment("/a", "x.ts", 0, "h1", "Earlier")
    const { result } = setup()
    await act(async () => {
      await result.current.loadScope()
    })
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(Object.values(result.current.comments)).toContain("Earlier")
  })

  it("counts a stored comment whose hunk is gone as stale rather than dropping it silently", async () => {
    useDiffReviewStore.getState().setComment("/a", "x.ts", 0, "vanished", "Old")
    const { result } = setup()
    await act(async () => {
      await result.current.loadScope()
    })
    expect(result.current.staleCommentCount).toBe(1)
  })

  it("surfaces a root that could not be scoped without failing the rest", async () => {
    listMock.mockResolvedValue({
      files: [ref("/a", "x.ts")],
      unavailable: [{ repositoryRoot: "/b", reason: "missing-run" }],
    })
    const { result } = setup()
    await act(async () => {
      await result.current.loadScope()
    })
    expect(result.current.files).toHaveLength(1)
    expect(result.current.unavailableRoots).toEqual([
      { repositoryRoot: "/b", reason: "missing-run" },
    ])
  })

  it("surfaces a listing failure instead of leaving the sheet blank", async () => {
    listMock.mockRejectedValue(new Error("git exploded"))
    const { result } = setup()
    await act(async () => {
      await result.current.loadScope()
    })
    expect(result.current.error).toBe("git exploded")
  })
})

describe("pull requests", () => {
  it("resolves each repository's own branch", async () => {
    gitStatusMock.mockImplementation(async (root: string) => ({
      branch: root === "/a" ? "fa" : "fb",
    }))
    const findForBranch = jest.fn(async (root: string) => pr(root, 1))
    const { result } = setup({ provider: provider({ findForBranch }) })
    await act(async () => {
      await result.current.lookupAll()
    })
    expect(findForBranch).toHaveBeenCalledWith("/a", "fa")
    expect(findForBranch).toHaveBeenCalledWith("/b", "fb")
  })

  it("creates against the root's own base ref", async () => {
    const create = jest.fn(async () => pr("/b", 5))
    const { result } = setup({ provider: provider({ create }) })
    act(() => result.current.setRootRefs("/b", { baseRef: "develop" }))
    await act(async () => {
      await result.current.createFor("/b", { title: "T", body: "B", draft: true })
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryRoot: "/b", baseRef: "develop" })
    )
  })

  it("refuses to push a repository with no checked-out branch", async () => {
    gitStatusMock.mockResolvedValue({ branch: null })
    const { result } = setup()
    await act(async () => {
      await result.current.pushRoot("/a")
    })
    expect(result.current.error).toMatch(/branch is unavailable for \/a/)
  })
})

describe("publishing", () => {
  async function authored() {
    listMock.mockResolvedValue({ files: [ref("/a", "x.ts"), ref("/b", "y.ts")], unavailable: [] })
    const { result } = setup()
    await act(async () => {
      await result.current.loadScope()
    })
    for (const file of result.current.files) {
      await act(async () => {
        await result.current.loadFile(file)
      })
    }
    act(() => {
      for (const file of result.current.files) {
        result.current.setComment(file, hunk(), `note for ${file.repositoryRoot}`)
      }
    })
    await act(async () => {
      await result.current.lookupAll()
    })
    return result
  }

  it("sends one bundle per repository with only that repository's comments", async () => {
    const result = await authored()
    await act(async () => {
      await result.current.publish()
    })

    expect(published).toHaveLength(2)
    for (const [pullRequest, bundle] of published) {
      expect(bundle.repositoryRoots).toHaveLength(1)
      const root = bundle.repositoryRoots[0]
      expect(pullRequest.repository).toBe(root)
      expect(bundle.comments.every((c) => c.anchor.repositoryRoot === root)).toBe(true)
    }
  })

  it("stamps a commit-scope comment with that root's OWN commit SHA", async () => {
    listMock.mockResolvedValue({
      files: [{ ...ref("/a", "x.ts"), source: "commit" as const }],
      unavailable: [],
    })
    const { result } = setup()
    act(() => result.current.setScope("commit"))
    act(() => result.current.setRootRefs("/a", { commitSha: "sha-a" }))
    await act(async () => {
      await result.current.loadScope()
    })
    await act(async () => {
      await result.current.loadFile(result.current.files[0])
    })
    act(() => result.current.setComment(result.current.files[0], hunk(), "note"))
    await act(async () => {
      await result.current.lookupAll()
    })
    await act(async () => {
      await result.current.publish()
    })
    expect(published[0][1].comments[0].anchor.commitSha).toBe("sha-a")
  })

  it("records a failed leg without losing the succeeded one", async () => {
    listMock.mockResolvedValue({ files: [ref("/a", "x.ts"), ref("/b", "y.ts")], unavailable: [] })
    let call = 0
    const publishFeedback = jest.fn(async () => {
      call += 1
      if (call === 2) throw new Error("nope")
    })
    const { result } = setup({ provider: provider({ publishFeedback }) })

    await act(async () => {
      await result.current.loadScope()
    })
    for (const file of result.current.files) {
      await act(async () => {
        await result.current.loadFile(file)
      })
    }
    act(() => {
      for (const file of result.current.files) {
        result.current.setComment(file, hunk(), "note")
      }
    })
    await act(async () => {
      await result.current.lookupAll()
    })
    await act(async () => {
      await result.current.publish()
    })

    await waitFor(() => expect(result.current.delivery).not.toBeNull())
    expect(result.current.delivery!.legs.map((l) => l.status)).toEqual(["succeeded", "failed"])
    expect(result.current.failedLegs).toHaveLength(1)

    // Retry re-sends the failed repository only; the succeeded leg is carried
    // forward rather than published a second time.
    publishFeedback.mockClear()
    await act(async () => {
      await result.current.publish({ retry: true })
    })
    expect(publishFeedback).toHaveBeenCalledTimes(1)
  })
})
