/**
 * Tests for the Git Plugin API (`ctx.git`).
 *
 * Covers permission gating (git:read / git:write via the PermissionGuard
 * proxy), active-repo resolution (no arbitrary paths), and 1:1 forwarding
 * to the `lib/git/commands.ts` seam.
 */

import { createGitAPI, NoActiveRepoError } from "./git-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"

// --- mock the git command seam ------------------------------------------
jest.mock("@/lib/git/commands", () => ({
  gitIsRepo: jest.fn(async () => true),
  gitRepoState: jest.fn(async () => ({ head: "main" })),
  gitStatus: jest.fn(async () => ({ branch: "main", staged: [], changes: [], merge: [] })),
  gitLog: jest.fn(async () => [{ sha: "abc" }]),
  gitFileHistory: jest.fn(async () => [{ sha: "def" }]),
  gitDiffFile: jest.fn(async () => ({ path: "a.ts" })),
  gitDiffCommit: jest.fn(async () => ({ path: "a.ts" })),
  gitCommitFiles: jest.fn(async () => [{ path: "a.ts" }]),
  gitBranches: jest.fn(async () => [{ name: "main" }]),
  gitRemotes: jest.fn(async () => [{ name: "origin" }]),
  gitStashList: jest.fn(async () => []),
  gitConflicts: jest.fn(async () => []),
  gitStage: jest.fn(async () => undefined),
  gitUnstage: jest.fn(async () => undefined),
  gitDiscard: jest.fn(async () => undefined),
  gitDiscardAll: jest.fn(async () => undefined),
  gitCommit: jest.fn(async () => "newsha"),
  gitCheckoutBranch: jest.fn(async () => undefined),
  gitCreateBranch: jest.fn(async () => undefined),
  gitDeleteBranch: jest.fn(async () => undefined),
  gitRenameBranch: jest.fn(async () => undefined),
  gitFetch: jest.fn(async () => undefined),
  gitPull: jest.fn(async () => undefined),
  gitPush: jest.fn(async () => undefined),
  gitSync: jest.fn(async () => ({ ahead: 1, behind: 2 })),
  gitStashPush: jest.fn(async () => undefined),
  gitStashPop: jest.fn(async () => undefined),
  gitStashApply: jest.fn(async () => undefined),
  gitStashDrop: jest.fn(async () => undefined),
  gitResolveConflict: jest.fn(async () => undefined),
  gitMergeAbort: jest.fn(async () => undefined),
}))

// --- mock the git store --------------------------------------------------
let mockRootDir: string | null = "/repo"
const storeSubscribers = new Set<(state: unknown, prev: unknown) => void>()
jest.mock("@/stores/git/git-store", () => ({
  useGitStore: {
    getState: jest.fn(() => ({ rootDir: mockRootDir })),
    subscribe: jest.fn((cb: (state: unknown, prev: unknown) => void) => {
      storeSubscribers.add(cb)
      return () => storeSubscribers.delete(cb)
    }),
  },
}))

import * as git from "@/lib/git/commands"

const PLUGIN = "git-plugin"

function emitStatusChange(status: unknown, prev: unknown) {
  for (const cb of storeSubscribers) cb({ status }, { status: prev })
}

describe("createGitAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    mockRootDir = "/repo"
    storeSubscribers.clear()
    resetPermissionGuard()
    guard = getPermissionGuard()
  })

  describe("permission gating", () => {
    it("throws PermissionError on a read without git:read", () => {
      guard.registerPlugin(PLUGIN, [])
      const api = createGitAPI(PLUGIN)
      expect(() => api.status()).toThrow(PermissionError)
      expect(git.gitStatus).not.toHaveBeenCalled()
    })

    it("throws PermissionError on a write without git:write", () => {
      guard.registerPlugin(PLUGIN, ["git:read"])
      const api = createGitAPI(PLUGIN)
      expect(() => api.commit("msg")).toThrow(PermissionError)
      expect(git.gitCommit).not.toHaveBeenCalled()
    })

    it("git:read does not unlock writes", () => {
      guard.registerPlugin(PLUGIN, ["git:read"])
      const api = createGitAPI(PLUGIN)
      expect(() => api.status()).not.toThrow()
      expect(() => api.push()).toThrow(PermissionError)
    })
  })

  describe("active-repo resolution", () => {
    it("getRoot returns the bound root", () => {
      guard.registerPlugin(PLUGIN, ["git:read"])
      const api = createGitAPI(PLUGIN)
      expect(api.getRoot()).toBe("/repo")
    })

    it("throws NoActiveRepoError when no repo is bound", () => {
      mockRootDir = null
      guard.registerPlugin(PLUGIN, ["git:read"])
      const api = createGitAPI(PLUGIN)
      // resolveRoot() runs while building the call args → synchronous throw.
      expect(() => api.status()).toThrow(NoActiveRepoError)
      expect(git.gitStatus).not.toHaveBeenCalled()
    })

    it("getRoot returns null when nothing is bound (no throw)", () => {
      mockRootDir = null
      guard.registerPlugin(PLUGIN, ["git:read"])
      const api = createGitAPI(PLUGIN)
      expect(api.getRoot()).toBeNull()
    })

    it("never lets the caller specify an arbitrary repoPath — always uses rootDir", async () => {
      guard.registerPlugin(PLUGIN, ["git:read"])
      const api = createGitAPI(PLUGIN)
      await api.status()
      expect(git.gitStatus).toHaveBeenCalledWith("/repo")
    })
  })

  describe("read forwarding", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["git:read"]))

    it("log forwards maxCount/skip with defaults", async () => {
      const api = createGitAPI(PLUGIN)
      await api.log()
      expect(git.gitLog).toHaveBeenCalledWith("/repo", 50, 0)
      await api.log(10, 5)
      expect(git.gitLog).toHaveBeenCalledWith("/repo", 10, 5)
    })

    it("diffFile defaults staged to false", async () => {
      const api = createGitAPI(PLUGIN)
      await api.diffFile("a.ts")
      expect(git.gitDiffFile).toHaveBeenCalledWith("/repo", "a.ts", false)
    })

    it("fileHistory / diffCommit / commitFiles / branches / remotes / stashList / conflicts forward", async () => {
      const api = createGitAPI(PLUGIN)
      await api.fileHistory("a.ts")
      await api.diffCommit("sha", "a.ts")
      await api.commitFiles("sha")
      await api.branches()
      await api.remotes()
      await api.stashList()
      await api.conflicts()
      expect(git.gitFileHistory).toHaveBeenCalledWith("/repo", "a.ts", 50)
      expect(git.gitDiffCommit).toHaveBeenCalledWith("/repo", "sha", "a.ts")
      expect(git.gitCommitFiles).toHaveBeenCalledWith("/repo", "sha")
      expect(git.gitBranches).toHaveBeenCalledWith("/repo")
      expect(git.gitRemotes).toHaveBeenCalledWith("/repo")
      expect(git.gitStashList).toHaveBeenCalledWith("/repo")
      expect(git.gitConflicts).toHaveBeenCalledWith("/repo")
    })

    it("onStatusChange fires only when status actually changes, and disposes", () => {
      const api = createGitAPI(PLUGIN)
      const handler = jest.fn()
      const dispose = api.onStatusChange(handler)
      const status = { branch: "x" }
      emitStatusChange(status, null)
      expect(handler).toHaveBeenCalledWith(status)
      emitStatusChange(status, status) // same ref → no change, no fire
      expect(handler).toHaveBeenCalledTimes(1)
      dispose()
      expect(storeSubscribers.size).toBe(0)
    })
  })

  describe("write forwarding", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["git:read", "git:write"]))

    it("stage/unstage/discard pass paths + hunkPatch", async () => {
      const api = createGitAPI(PLUGIN)
      await api.stage(["a.ts"], "PATCH")
      await api.unstage(["b.ts"])
      await api.discard(["c.ts"], "P2")
      await api.discardAll(true)
      expect(git.gitStage).toHaveBeenCalledWith("/repo", ["a.ts"], "PATCH")
      expect(git.gitUnstage).toHaveBeenCalledWith("/repo", ["b.ts"], undefined)
      expect(git.gitDiscard).toHaveBeenCalledWith("/repo", ["c.ts"], "P2")
      expect(git.gitDiscardAll).toHaveBeenCalledWith("/repo", true)
    })

    it("commit maps amend/signoff options and returns the sha", async () => {
      const api = createGitAPI(PLUGIN)
      const sha = await api.commit("msg", { amend: true, signoff: true })
      expect(sha).toBe("newsha")
      expect(git.gitCommit).toHaveBeenCalledWith("/repo", "msg", true, true)
      await api.commit("plain")
      expect(git.gitCommit).toHaveBeenLastCalledWith("/repo", "plain", false, false)
    })

    it("branch ops forward", async () => {
      const api = createGitAPI(PLUGIN)
      await api.createBranch("feat", { checkout: true, from: "main" })
      await api.checkoutBranch("feat")
      await api.deleteBranch("old", true)
      await api.renameBranch("new", "old")
      expect(git.gitCreateBranch).toHaveBeenCalledWith("/repo", "feat", true, "main")
      expect(git.gitCheckoutBranch).toHaveBeenCalledWith("/repo", "feat")
      expect(git.gitDeleteBranch).toHaveBeenCalledWith("/repo", "old", true)
      expect(git.gitRenameBranch).toHaveBeenCalledWith("/repo", "new", "old")
    })

    it("network ops forward and sync returns ahead/behind", async () => {
      const api = createGitAPI(PLUGIN)
      await api.fetch("origin", true)
      await api.pull({ rebase: true })
      await api.push({ setUpstream: true })
      const ab = await api.sync()
      expect(git.gitFetch).toHaveBeenCalledWith("/repo", "origin", true)
      expect(git.gitPull).toHaveBeenCalledWith("/repo", { rebase: true })
      expect(git.gitPush).toHaveBeenCalledWith("/repo", { setUpstream: true })
      expect(ab).toEqual({ ahead: 1, behind: 2 })
    })

    it("stash + conflict ops forward", async () => {
      const api = createGitAPI(PLUGIN)
      await api.stashPush({ message: "wip" })
      await api.stashPop(0)
      await api.stashApply(1)
      await api.stashDrop(2)
      await api.resolveConflict("a.ts", { side: "ours" })
      await api.mergeAbort()
      expect(git.gitStashPush).toHaveBeenCalledWith("/repo", { message: "wip" })
      expect(git.gitStashPop).toHaveBeenCalledWith("/repo", 0)
      expect(git.gitStashApply).toHaveBeenCalledWith("/repo", 1)
      expect(git.gitStashDrop).toHaveBeenCalledWith("/repo", 2)
      expect(git.gitResolveConflict).toHaveBeenCalledWith("/repo", "a.ts", { side: "ours" })
      expect(git.gitMergeAbort).toHaveBeenCalledWith("/repo")
    })

    it("isRepo / repoState forward", async () => {
      const api = createGitAPI(PLUGIN)
      expect(await api.isRepo()).toBe(true)
      await api.repoState()
      expect(git.gitIsRepo).toHaveBeenCalledWith("/repo")
      expect(git.gitRepoState).toHaveBeenCalledWith("/repo")
    })
  })
})
