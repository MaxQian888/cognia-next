import type { ChatSession } from "@cognia/agent-config-types"
import type { PrObservation } from "@/lib/github/pr-observe/types"
import type { TimerHandle } from "@/lib/ai/agent/team/pr-feedback/observer"
import {
  ProjectPrWatch,
  deliverThreadNudge,
  persistThreadPr,
  type PrWatchDeps,
  type ThreadPrBinding,
} from "./pr-watch"

const thread = (id: string, extra: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    projectId: "p1",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    projectRole: "thread",
    projectThread: { coordinatorSessionId: "c", brief: "b", proposedBy: "coordinator" },
    executionContext: {
      location: "managedWorktree",
      projectId: "p1",
      projectRoot: "/repo",
      worktreePath: `/wt/${id}`,
      branch: `thread/${id}`,
      taskWorkspace: { taskId: "t", workspaceKey: "k" },
    },
    ...extra,
  }) as ChatSession

function obs(over: Partial<PrObservation["pr"]> = {}): PrObservation {
  return {
    fetched: true,
    observedAt: 5,
    repo: "o/n",
    pr: {
      url: "https://github.com/o/n/pull/7",
      number: 7,
      state: "open",
      draft: false,
      merged: false,
      closed: false,
      sourceBranch: "thread/t1",
      targetBranch: "main",
      headSha: "s1",
      title: "t",
      additions: 1,
      deletions: 0,
      author: "dev",
      ...over,
    },
    ci: { summary: "passing", headSha: "s1", failedChecks: [] },
    review: { decision: "none", threads: [] },
    mergeability: { state: "mergeable", mergeable: true, conflict: false, behindBase: false },
    changed: { metadata: true, ci: true, review: true },
    etags: {},
  }
}

function setup(over: Partial<PrWatchDeps> = {}) {
  const timers: Array<{ fn: () => void; handle: TimerHandle }> = []
  const deps: PrWatchDeps = {
    resolveRepo: jest.fn(async () => ({
      fullName: "o/n",
      defaultBranch: "main",
      defaultBranchSource: "remote-head",
      defaultBranchExists: true,
    })) as unknown as PrWatchDeps["resolveRepo"],
    resolveOctokit: jest.fn(async () => ({ request: jest.fn() })),
    fetch: jest.fn(async () => obs()) as unknown as PrWatchDeps["fetch"],
    persist: jest.fn(async () => undefined),
    loadSignature: async () => undefined,
    deliver: jest.fn(),
    onError: jest.fn(),
    timers: {
      now: () => 5,
      setTimer: (fn) => {
        const handle = { cancelled: false }
        timers.push({ fn, handle })
        return handle
      },
      clearTimer: (h) => {
        h.cancelled = true
      },
    },
    pollIntervalMs: 1000,
    ...over,
  }
  const flush = async () => {
    const live = timers.splice(0).filter((t) => !t.handle.cancelled)
    for (const t of live) await t.fn()
  }
  return { deps, watch: new ProjectPrWatch(deps), flush }
}

describe("ProjectPrWatch", () => {
  it("tracks a thread's branch, fetches by branch and persists", async () => {
    const { deps, watch, flush } = setup()
    await expect(watch.track(thread("t1"))).resolves.toBe(true)
    await expect(watch.track(thread("t1"))).resolves.toBe(true)
    expect(deps.resolveRepo).toHaveBeenCalledWith("/wt/t1")
    await flush()
    expect(deps.fetch).toHaveBeenCalledWith(
      expect.anything(),
      "o/n",
      { branch: "thread/t1" },
      undefined,
      5
    )
    expect(deps.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ sessionId: "t1", projectId: "p1" }),
      })
    )
    expect(watch.tracked()).toEqual(["t1"])
  })

  it("skips threads without a branch, on the trunk, or without GitHub access", async () => {
    const { watch } = setup()
    await expect(watch.track(thread("a", { executionContext: undefined }))).resolves.toBe(false)
    const trunk = thread("b")
    trunk.executionContext!.branch = "main"
    await expect(watch.track(trunk)).resolves.toBe(false)
    const noAuth = setup({ resolveOctokit: async () => null })
    await expect(noAuth.watch.track(thread("c"))).resolves.toBe(false)
  })

  it("syncs to the unresolved threads", async () => {
    const { watch } = setup()
    await watch.sync([thread("t1"), thread("t2")])
    expect(watch.tracked().sort()).toEqual(["t1", "t2"])
    await watch.sync([
      thread("t1", {
        projectThread: { coordinatorSessionId: "c", brief: "b", proposedBy: "user", resolvedAt: 1 },
      }),
    ])
    expect(watch.tracked()).toEqual([])
  })
})

describe("persistThreadPr", () => {
  const binding: ThreadPrBinding = { sessionId: "t1", projectId: "p1", repo: "o/n", branch: "b" }

  it("records the row and mirrors a new PR reference onto the thread", async () => {
    const record = jest.fn(async () => undefined)
    const updateSession = jest.fn(async () => undefined)
    await persistThreadPr(
      {
        binding,
        observation: obs(),
        derivedStatus: "pr_open",
        signature: {},
      },
      { record, getSession: async () => thread("t1"), updateSession }
    )
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1", prNumber: 7, derivedStatus: "pr_open" })
    )
    expect(updateSession).toHaveBeenCalledWith("t1", {
      projectThread: expect.objectContaining({
        prRef: { repo: "o/n", branch: "b", number: 7, url: "https://github.com/o/n/pull/7" },
      }),
    })
  })

  it("does not rewrite an unchanged reference", async () => {
    const updateSession = jest.fn()
    await persistThreadPr(
      { binding, observation: obs(), derivedStatus: "pr_open", signature: {} },
      {
        record: async () => undefined,
        getSession: async () =>
          thread("t1", {
            projectThread: {
              coordinatorSessionId: "c",
              brief: "b",
              proposedBy: "user",
              prRef: { repo: "o/n", branch: "b", number: 7, url: "https://github.com/o/n/pull/7" },
            },
          }),
        updateSession,
      }
    )
    expect(updateSession).not.toHaveBeenCalled()
  })
})

describe("deliverThreadNudge", () => {
  const nudge = {
    memberId: "t1",
    message: "CI failed",
    generation: 1,
    key: "ci",
    category: "ci" as const,
  }
  const binding: ThreadPrBinding = { sessionId: "t1", projectId: "p1", repo: "o/n", branch: "b" }

  it("sends the nudge into the thread only with auto-fix on", () => {
    const send = jest.fn(async () => true)
    deliverThreadNudge(binding, nudge, { autoFix: () => false, send })
    expect(send).not.toHaveBeenCalled()
    deliverThreadNudge(binding, nudge, { autoFix: () => true, send })
    expect(send).toHaveBeenCalledWith("t1", "CI failed")
  })
})
