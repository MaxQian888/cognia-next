import { AgentWorkspaceAllocator, type WorktreeGitOps, type WorktreeHandle } from "./allocator"
import { reconcile, type MergeOps, type ReconcileCandidate } from "./reconciler"

function makeGit(): WorktreeGitOps & {
  removeCalls: Array<{ path: string; deleteBranch?: string }>
} {
  const removeCalls: Array<{ path: string; deleteBranch?: string }> = []
  return {
    removeCalls,
    add: async () => {},
    remove: async (_repo, path, _force, deleteBranch) => {
      removeCalls.push({ path, deleteBranch })
    },
    list: async () => [],
    commit: async () => "sha",
    prune: async () => {},
  }
}

function makeMerge(over: Partial<MergeOps> = {}): MergeOps & {
  merges: string[]
  aborts: number
} {
  const merges: string[] = []
  const state = { aborts: 0 }
  return {
    merges,
    get aborts() {
      return state.aborts
    },
    merge: async (_repo, branch) => {
      merges.push(branch)
    },
    mergeAbort: async () => {
      state.aborts++
    },
    ...over,
  }
}

async function makeCandidates(
  alloc: AgentWorkspaceAllocator,
  specs: Array<{ task: string; ok: boolean }>
): Promise<ReconcileCandidate[]> {
  const out: ReconcileCandidate[] = []
  for (const s of specs) {
    const handle: WorktreeHandle = await alloc.allocate({
      runId: "r",
      teammateName: "A",
      taskId: s.task,
    })
    out.push({ handle, ok: s.ok })
  }
  return out
}

const baseOpts = { mainRepo: "/repo", worktreeBase: "/wt", uid: () => "u", delay: async () => {} }

describe("reconcile", () => {
  it("manual leaves every branch untouched", async () => {
    const git = makeGit()
    let n = 0
    const alloc = new AgentWorkspaceAllocator({ ...baseOpts, git, uid: () => String(n++) })
    const cands = await makeCandidates(alloc, [
      { task: "t1", ok: true },
      { task: "t2", ok: true },
    ])
    const res = await reconcile(alloc, cands, { runId: "r", mode: "manual" })
    expect(res.mode).toBe("manual")
    expect(res.branches).toEqual(["agent/r/A/t1", "agent/r/A/t2"])
    expect(git.removeCalls).toHaveLength(0)
  })

  it("pipeline returns the single shared branch", async () => {
    const git = makeGit()
    const alloc = new AgentWorkspaceAllocator({ ...baseOpts, git })
    const h = await alloc.allocate({
      runId: "r",
      teammateName: "A",
      taskId: "t1",
      workspaceKey: "pipe",
    })
    const res = await reconcile(alloc, [{ handle: h, ok: true }], { runId: "r", mode: "pipeline" })
    expect(res.mode).toBe("pipeline")
    expect(res.resultBranch).toBe("agent/r/A/t1")
    expect(res.branches).toEqual(["agent/r/A/t1"])
  })

  it("merge-all merges each successful branch into a fresh integration branch", async () => {
    const git = makeGit()
    const merge = makeMerge()
    let n = 0
    const alloc = new AgentWorkspaceAllocator({ ...baseOpts, git, uid: () => String(n++) })
    const cands = await makeCandidates(alloc, [
      { task: "t1", ok: true },
      { task: "t2", ok: false }, // skipped (not ok)
      { task: "t3", ok: true },
    ])
    const res = await reconcile(alloc, cands, { runId: "r", mode: "merge-all", merge })
    expect(res.mode).toBe("merge-all")
    expect(res.resultBranch).toBe("agent/r/integration/all")
    expect(merge.merges).toEqual(["agent/r/A/t1", "agent/r/A/t3"])
    expect(res.conflict).toBeUndefined()
    // retain default keep-winner → agent worktrees removed, branches kept.
    expect(git.removeCalls.every((c) => c.deleteBranch === undefined)).toBe(true)
    expect(git.removeCalls.length).toBe(3)
  })

  it("merge-all aborts and reports on the first conflict", async () => {
    const git = makeGit()
    const merge = makeMerge({
      merge: async (_repo, branch) => {
        if (branch === "agent/r/A/t2") throw { kind: "mergeConflict", detail: "CONFLICT in x" }
      },
    })
    let n = 0
    const alloc = new AgentWorkspaceAllocator({ ...baseOpts, git, uid: () => String(n++) })
    const cands = await makeCandidates(alloc, [
      { task: "t1", ok: true },
      { task: "t2", ok: true },
    ])
    const res = await reconcile(alloc, cands, { runId: "r", mode: "merge-all", merge })
    expect(res.conflict).toEqual({ branch: "agent/r/A/t2", detail: "CONFLICT in x" })
    expect(merge.aborts).toBe(1)
    // conflict path does not clean up worktrees.
    expect(git.removeCalls).toHaveLength(0)
  })

  it("merge-all with retain=all keeps agent worktrees", async () => {
    const git = makeGit()
    const merge = makeMerge()
    let n = 0
    const alloc = new AgentWorkspaceAllocator({ ...baseOpts, git, uid: () => String(n++) })
    const cands = await makeCandidates(alloc, [{ task: "t1", ok: true }])
    await reconcile(alloc, cands, { runId: "r", mode: "merge-all", retain: "all", merge })
    expect(git.removeCalls).toHaveLength(0)
  })

  it("select first-success picks the first ok branch and prunes losers", async () => {
    const git = makeGit()
    let n = 0
    const alloc = new AgentWorkspaceAllocator({ ...baseOpts, git, uid: () => String(n++) })
    const cands = await makeCandidates(alloc, [
      { task: "t1", ok: false },
      { task: "t2", ok: true }, // winner
      { task: "t3", ok: true },
    ])
    const res = await reconcile(alloc, cands, {
      runId: "r",
      mode: "select",
      selectStrategy: "first-success",
    })
    expect(res.winnerKey).toBe("t2")
    expect(res.resultBranch).toBe("agent/r/A/t2")
    // losers t1 + t3 removed with their branches; winner kept.
    expect(git.removeCalls.map((c) => c.deleteBranch).sort()).toEqual([
      "agent/r/A/t1",
      "agent/r/A/t3",
    ])
  })

  it("select judge uses the injected reviewer's choice", async () => {
    const git = makeGit()
    let n = 0
    const alloc = new AgentWorkspaceAllocator({ ...baseOpts, git, uid: () => String(n++) })
    const cands = await makeCandidates(alloc, [
      { task: "t1", ok: true },
      { task: "t2", ok: true },
    ])
    const judge = jest.fn(async () => "t2")
    const res = await reconcile(alloc, cands, {
      runId: "r",
      mode: "select",
      selectStrategy: "judge",
      judge,
    })
    expect(judge).toHaveBeenCalledWith(cands)
    expect(res.winnerKey).toBe("t2")
  })

  it("select judge without a callback defers to manual selection", async () => {
    const git = makeGit()
    let n = 0
    const alloc = new AgentWorkspaceAllocator({ ...baseOpts, git, uid: () => String(n++) })
    const cands = await makeCandidates(alloc, [{ task: "t1", ok: true }])
    const res = await reconcile(alloc, cands, {
      runId: "r",
      mode: "select",
      selectStrategy: "judge",
    })
    expect(res.winnerKey).toBeUndefined()
    expect(res.branches).toEqual(["agent/r/A/t1"])
    expect(git.removeCalls).toHaveLength(0)
  })

  it("select manual leaves all candidates for the UI", async () => {
    const git = makeGit()
    let n = 0
    const alloc = new AgentWorkspaceAllocator({ ...baseOpts, git, uid: () => String(n++) })
    const cands = await makeCandidates(alloc, [
      { task: "t1", ok: true },
      { task: "t2", ok: true },
    ])
    const res = await reconcile(alloc, cands, {
      runId: "r",
      mode: "select",
      selectStrategy: "manual",
    })
    expect(res.branches).toHaveLength(2)
    expect(git.removeCalls).toHaveLength(0)
  })

  it("select first-success with no successful candidate reports and prunes nothing", async () => {
    const git = makeGit()
    let n = 0
    const alloc = new AgentWorkspaceAllocator({ ...baseOpts, git, uid: () => String(n++) })
    const cands = await makeCandidates(alloc, [{ task: "t1", ok: false }])
    const res = await reconcile(alloc, cands, {
      runId: "r",
      mode: "select",
      selectStrategy: "first-success",
    })
    expect(res.winnerKey).toBeUndefined()
    expect(res.summary).toMatch(/no successful/i)
    expect(git.removeCalls).toHaveLength(0)
  })
})
