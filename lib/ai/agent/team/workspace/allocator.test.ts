import {
  AgentWorkspaceAllocator,
  defaultWorktreeBase,
  sanitizeSegment,
  type WorktreeGitOps,
} from "./allocator"

function makeGit(over: Partial<WorktreeGitOps> = {}): WorktreeGitOps & {
  addCalls: Array<{ repo: string; path: string; branch: string; baseRef?: string }>
  removeCalls: Array<{ repo: string; path: string; force: boolean; deleteBranch?: string }>
  pruneCalls: string[]
} {
  const addCalls: Array<{ repo: string; path: string; branch: string; baseRef?: string }> = []
  const removeCalls: Array<{ repo: string; path: string; force: boolean; deleteBranch?: string }> =
    []
  const pruneCalls: string[] = []
  return {
    addCalls,
    removeCalls,
    pruneCalls,
    add: async (repo, path, branch, baseRef) => {
      addCalls.push({ repo, path, branch, baseRef })
    },
    remove: async (repo, path, force, deleteBranch) => {
      removeCalls.push({ repo, path, force, deleteBranch })
    },
    list: async () => [],
    commit: async () => "sha",
    prune: async (repo) => {
      pruneCalls.push(repo)
    },
    ...over,
  }
}

const base = { mainRepo: "/repo", worktreeBase: "/wt", uid: () => "u", delay: async () => {} }

describe("sanitizeSegment", () => {
  it("replaces unsafe chars, trims, and never returns empty", () => {
    expect(sanitizeSegment("Alice Smith")).toBe("Alice-Smith")
    expect(sanitizeSegment("a/b:c~d")).toBe("a-b-c-d")
    expect(sanitizeSegment("..weird..")).toBe("weird")
    expect(sanitizeSegment("!!!")).toBe("x")
    expect(sanitizeSegment("ok_1.2-3")).toBe("ok_1.2-3")
  })
})

describe("defaultWorktreeBase", () => {
  it("places worktrees in a hidden sibling of the repo", () => {
    expect(defaultWorktreeBase("/home/me/proj")).toBe("/home/me/.cognia-agent-worktrees/proj")
    expect(defaultWorktreeBase("/home/me/proj/")).toBe("/home/me/.cognia-agent-worktrees/proj")
  })
  it("normalizes windows separators to forward slashes", () => {
    expect(defaultWorktreeBase("C:\\Users\\me\\proj")).toBe(
      "C:/Users/me/.cognia-agent-worktrees/proj"
    )
  })
})

describe("AgentWorkspaceAllocator", () => {
  it("allocates a worktree with the right branch, path, and baseRef", async () => {
    const git = makeGit()
    const alloc = new AgentWorkspaceAllocator({ ...base, baseRef: "HEAD", git })
    const h = await alloc.allocate({ runId: "run_1", teammateName: "Alice", taskId: "t1" })

    expect(h.branch).toBe("agent/run_1/Alice/t1")
    expect(h.path).toBe("/wt/run_1/t1-u")
    expect(git.addCalls).toEqual([
      { repo: "/repo", path: "/wt/run_1/t1-u", branch: "agent/run_1/Alice/t1", baseRef: "HEAD" },
    ])
    expect(alloc.allocated()).toHaveLength(1)
  })

  it("sanitizes teammate and task names into the branch", async () => {
    const git = makeGit()
    const alloc = new AgentWorkspaceAllocator({ ...base, git })
    const h = await alloc.allocate({
      runId: "run_1",
      teammateName: "Front End",
      taskId: "feat/login",
    })
    expect(h.branch).toBe("agent/run_1/Front-End/feat-login")
  })

  it("reuses the same worktree for a repeated workspaceKey (pipeline)", async () => {
    const git = makeGit()
    const alloc = new AgentWorkspaceAllocator({ ...base, git })
    const a = await alloc.allocate({
      runId: "r",
      teammateName: "A",
      taskId: "t1",
      workspaceKey: "pipe",
    })
    const b = await alloc.allocate({
      runId: "r",
      teammateName: "B",
      taskId: "t2",
      workspaceKey: "pipe",
    })
    expect(b).toBe(a)
    expect(git.addCalls).toHaveLength(1)
    expect(alloc.allocated()).toHaveLength(1)
  })

  it("allocates distinct worktrees for distinct tasks", async () => {
    const git = makeGit()
    let n = 0
    const alloc = new AgentWorkspaceAllocator({ ...base, git, uid: () => String(n++) })
    const a = await alloc.allocate({ runId: "r", teammateName: "A", taskId: "t1" })
    const b = await alloc.allocate({ runId: "r", teammateName: "A", taskId: "t2" })
    expect(a.path).not.toBe(b.path)
    expect(git.addCalls).toHaveLength(2)
  })

  it("fail-closed: a non-lock error propagates and stores no handle", async () => {
    const git = makeGit({
      add: async () => {
        throw { kind: "commandFailed", detail: "boom" }
      },
    })
    const alloc = new AgentWorkspaceAllocator({ ...base, git })
    await expect(
      alloc.allocate({ runId: "r", teammateName: "A", taskId: "t1" })
    ).rejects.toBeDefined()
    expect(alloc.allocated()).toHaveLength(0)
  })

  it("retries on lock contention then succeeds", async () => {
    let attempts = 0
    const delays: number[] = []
    const git = makeGit({
      add: async () => {
        attempts++
        if (attempts < 3) throw { kind: "lockHeld", detail: "index.lock" }
      },
    })
    const alloc = new AgentWorkspaceAllocator({
      ...base,
      git,
      maxAttempts: 3,
      delay: async (a) => {
        delays.push(a)
      },
    })
    const h = await alloc.allocate({ runId: "r", teammateName: "A", taskId: "t1" })
    expect(attempts).toBe(3)
    expect(delays).toEqual([1, 2])
    expect(h.branch).toBe("agent/r/A/t1")
  })

  it("gives up (fail-closed) after exhausting lock retries", async () => {
    const git = makeGit({
      add: async () => {
        throw { kind: "lockHeld", detail: "index.lock" }
      },
    })
    const alloc = new AgentWorkspaceAllocator({ ...base, git, maxAttempts: 2 })
    await expect(
      alloc.allocate({ runId: "r", teammateName: "A", taskId: "t1" })
    ).rejects.toBeDefined()
    expect(alloc.allocated()).toHaveLength(0)
  })

  it("commit delegates to the git seam with the worktree path", async () => {
    const commit = jest.fn(async () => "abc123")
    const git = makeGit({ commit })
    const alloc = new AgentWorkspaceAllocator({ ...base, git })
    const h = await alloc.allocate({ runId: "r", teammateName: "A", taskId: "t1" })
    const sha = await alloc.commit(h, "agent work")
    expect(commit).toHaveBeenCalledWith(h.path, "agent work")
    expect(sha).toBe("abc123")
  })

  it("remove force-removes and optionally deletes the branch, forgetting the handle", async () => {
    const git = makeGit()
    const alloc = new AgentWorkspaceAllocator({ ...base, git })
    const h = await alloc.allocate({ runId: "r", teammateName: "A", taskId: "t1" })

    await alloc.remove(h, { deleteBranch: true })
    expect(git.removeCalls).toEqual([
      { repo: "/repo", path: h.path, force: true, deleteBranch: h.branch },
    ])
    expect(alloc.allocated()).toHaveLength(0)
  })

  it("remove without deleteBranch leaves the branch intact", async () => {
    const git = makeGit()
    const alloc = new AgentWorkspaceAllocator({ ...base, git })
    const h = await alloc.allocate({ runId: "r", teammateName: "A", taskId: "t1" })
    await alloc.remove(h)
    expect(git.removeCalls[0]?.deleteBranch).toBeUndefined()
  })

  it("gc removes every worktree, then prunes, tolerating individual failures", async () => {
    let n = 0
    let calls = 0
    const git = makeGit({
      remove: async () => {
        calls++
        if (calls === 1) throw new Error("busy")
      },
    })
    const alloc = new AgentWorkspaceAllocator({ ...base, git, uid: () => String(n++) })
    await alloc.allocate({ runId: "r", teammateName: "A", taskId: "t1" })
    await alloc.allocate({ runId: "r", teammateName: "A", taskId: "t2" })

    await expect(alloc.gc()).resolves.toBeUndefined()
    expect(calls).toBe(2) // both attempted despite the first throwing
    // A dangling admin entry (from the failed remove) is reclaimed by prune.
    expect(git.pruneCalls).toEqual(["/repo"])
  })

  it("gc swallows a failing prune", async () => {
    const git = makeGit({
      prune: async () => {
        throw new Error("prune boom")
      },
    })
    const alloc = new AgentWorkspaceAllocator({ ...base, git })
    await alloc.allocate({ runId: "r", teammateName: "A", taskId: "t1" })
    await expect(alloc.gc()).resolves.toBeUndefined()
  })
})
