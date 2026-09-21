import { act, renderHook, waitFor } from "@testing-library/react"
import { EMPTY_REPO_STATE, type GitFileChange, type GitStatus } from "@/types/git"
import { gitTargetFromRemote } from "@/lib/git/target"
import { useProjectGitStatus, type ProjectGitStatusDeps } from "./use-project-git-status"

function change(
  path: string,
  status: GitFileChange["status"],
  group: GitFileChange["group"]
): GitFileChange {
  return { path, origPath: null, status, staged: group === "staged", group }
}

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    changes: [],
    merge: [],
    isRebasing: false,
    isMerging: false,
    ...overrides,
  }
}

function deps(overrides: Partial<ProjectGitStatusDeps> = {}): {
  deps: ProjectGitStatusDeps
  emit: (rootDir: string) => void
  gitStatus: jest.Mock
} {
  let listener: ((event: { rootDir: string }) => void) | null = null
  const gitStatus = jest.fn().mockResolvedValue(status())
  return {
    gitStatus,
    emit: (rootDir: string) => listener?.({ rootDir }),
    deps: {
      gitStatus,
      // Default: the queried path is its own repo root — the identity case
      // every existing assertion was written against.
      gitRepoState: jest.fn(async (repoPath: string) => ({
        ...EMPTY_REPO_STATE,
        isRepo: true,
        rootDir: repoPath,
      })),
      subscribeGitStatusChanged: jest.fn((cb: (event: { rootDir: string }) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      }),
      ...overrides,
    },
  }
}

describe("useProjectGitStatus", () => {
  it("reports the branch and a path→status map after the initial fetch", async () => {
    const { deps: d } = deps()
    const { result } = renderHook(() => useProjectGitStatus("/repo", 0, d))
    await waitFor(() => expect(result.current.branch).toBe("main"))
    expect(result.current.byPath.size).toBe(0)
  })

  it("folds staged, unstaged and merge entries with the right precedence", async () => {
    const gitStatus = jest.fn().mockResolvedValue(
      status({
        staged: [change("a.ts", "added", "staged"), change("u.ts", "untracked", "staged")],
        changes: [change("a.ts", "modified", "changes"), change("b.ts", "deleted", "changes")],
        merge: [change("a.ts", "conflicted", "merge")],
      })
    )
    const { deps: d } = deps({ gitStatus })
    const { result } = renderHook(() => useProjectGitStatus("/repo", 0, d))
    await waitFor(() => expect(result.current.byPath.size).toBe(2))
    // Merge conflicts outrank everything; unstaged edits outrank staged.
    expect(result.current.byPath.get("a.ts")).toBe("conflicted")
    expect(result.current.byPath.get("b.ts")).toBe("deleted")
    // Staged-only untracked entries are skipped — the badge is for work to commit.
    expect(result.current.byPath.has("u.ts")).toBe(false)
  })

  it("swallows a rejected read — a non-repo root renders undecorated", async () => {
    const { deps: d } = deps({ gitStatus: jest.fn().mockRejectedValue(new Error("not a repo")) })
    const { result } = renderHook(() => useProjectGitStatus("/repo", 0, d))
    await waitFor(() => expect(d.gitStatus).toHaveBeenCalled())
    await waitFor(() => expect(result.current.branch).toBeNull())
  })

  it("refreshes when the push event's root overlaps the project root", async () => {
    const { deps: d, emit, gitStatus } = deps()
    renderHook(() => useProjectGitStatus("/repo/sub", 0, d))
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))
    act(() => emit("/repo")) // ancestor of the project root
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(2))
    act(() => emit("/repo/sub/deeper")) // project root is an ancestor
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(3))
  })

  it("ignores status events from unrelated roots", async () => {
    const { deps: d, emit, gitStatus } = deps()
    renderHook(() => useProjectGitStatus("/repo", 0, d))
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))
    act(() => emit("/elsewhere"))
    act(() => emit("/repo-suffix")) // shares a prefix but is not a descendant
    await new Promise((r) => setTimeout(r, 10))
    expect(gitStatus).toHaveBeenCalledTimes(1)
  })

  it("normalises separators and trailing slashes when matching roots", async () => {
    const { deps: d, emit, gitStatus } = deps()
    renderHook(() => useProjectGitStatus("/repo/", 0, d))
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))
    act(() => emit("\\repo\\"))
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(2))
  })

  it("re-fetches when the refresh token changes", async () => {
    const { deps: d, gitStatus } = deps()
    const { rerender } = renderHook(({ token }) => useProjectGitStatus("/repo", token, d), {
      initialProps: { token: 0 },
    })
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))
    rerender({ token: 1 })
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(2))
  })

  it("rebases repo-relative paths onto a nested editor root", async () => {
    // Editor rooted at repo/packages/app: the repo-root-relative status paths
    // must shed the `packages/app/` prefix to match tree rows — and changes
    // outside the nested root must not badge rows that share their tail.
    const gitStatus = jest.fn().mockResolvedValue(
      status({
        changes: [
          change("packages/app/src/a.ts", "modified", "changes"),
          change("src/other.ts", "modified", "changes"),
        ],
      })
    )
    const gitRepoState = jest
      .fn()
      .mockResolvedValue({ ...EMPTY_REPO_STATE, isRepo: true, rootDir: "/repo" })
    const { deps: d } = deps({ gitStatus, gitRepoState })
    const { result } = renderHook(() => useProjectGitStatus("/repo/packages/app", 0, d))
    await waitFor(() => expect(result.current.byPath.get("src/a.ts")).toBe("modified"))
    expect(result.current.byPath.has("src/other.ts")).toBe(false)
    expect(result.current.byPath.has("packages/app/src/a.ts")).toBe(false)
  })

  it("drops a repo-root path that would false-positive onto a nested row", async () => {
    // repo/src/a.ts modified while the editor sits at repo/packages/app: the
    // unrelated packages/app/src/a.ts row must stay clean.
    const gitStatus = jest
      .fn()
      .mockResolvedValue(status({ changes: [change("src/a.ts", "modified", "changes")] }))
    const gitRepoState = jest
      .fn()
      .mockResolvedValue({ ...EMPTY_REPO_STATE, isRepo: true, rootDir: "/repo" })
    const { deps: d } = deps({ gitStatus, gitRepoState })
    const { result } = renderHook(() => useProjectGitStatus("/repo/packages/app", 0, d))
    await waitFor(() => expect(gitStatus).toHaveBeenCalled())
    await waitFor(() => expect(result.current.branch).toBe("main"))
    expect(result.current.byPath.size).toBe(0)
  })

  it("prepends the repo's subdir when the editor root contains the repo", async () => {
    const gitStatus = jest
      .fn()
      .mockResolvedValue(status({ changes: [change("src/a.ts", "modified", "changes")] }))
    const gitRepoState = jest
      .fn()
      .mockResolvedValue({ ...EMPTY_REPO_STATE, isRepo: true, rootDir: "/repo/sub" })
    const { deps: d } = deps({ gitStatus, gitRepoState })
    const { result } = renderHook(() => useProjectGitStatus("/repo", 0, d))
    await waitFor(() => expect(result.current.byPath.get("sub/src/a.ts")).toBe("modified"))
    expect(result.current.byPath.has("src/a.ts")).toBe(false)
  })

  it("rebases remote-workspace targets by their workspace-relative paths", async () => {
    const gitStatus = jest
      .fn()
      .mockResolvedValue(
        status({ changes: [change("packages/app/src/a.ts", "modified", "changes")] })
      )
    const gitRepoState = jest.fn().mockResolvedValue({
      ...EMPTY_REPO_STATE,
      isRepo: true,
      // `gitRepoState` re-wraps a remote repo root as a remote target whose
      // relativePath is the repo root's position inside the workspace.
      rootDir: gitTargetFromRemote("ws-1", ""),
    })
    const { deps: d } = deps({ gitStatus, gitRepoState })
    const { result } = renderHook(() =>
      useProjectGitStatus(gitTargetFromRemote("ws-1", "packages/app"), 0, d)
    )
    await waitFor(() => expect(result.current.byPath.get("src/a.ts")).toBe("modified"))
  })

  it("keeps the pass-through when the repo root is undiscoverable", async () => {
    const gitStatus = jest
      .fn()
      .mockResolvedValue(status({ changes: [change("a.ts", "modified", "changes")] }))
    const gitRepoState = jest.fn().mockRejectedValue(new Error("no git"))
    const { deps: d } = deps({ gitStatus, gitRepoState })
    const { result } = renderHook(() => useProjectGitStatus("/repo", 0, d))
    await waitFor(() => expect(result.current.byPath.get("a.ts")).toBe("modified"))
  })
})
