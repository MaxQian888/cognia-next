const mockCalls: Array<[string, unknown[]]> = []
/** A function declaration, so the hoisted `jest.mock` factory can name it. */
function mockRecord(name: string, value: unknown = undefined) {
  return (...args: unknown[]) => {
    mockCalls.push([name, args])
    return Promise.resolve(value)
  }
}
jest.mock("@/lib/git/commands", () => ({
  gitStatus: mockRecord("gitStatus", { branch: "main" }),
  gitBranches: mockRecord("gitBranches", []),
  gitCreateBranch: mockRecord("gitCreateBranch"),
  gitDiffFile: mockRecord("gitDiffFile"),
  gitDiffRefsFiles: mockRecord("gitDiffRefsFiles", []),
  gitDiffRefsFile: mockRecord("gitDiffRefsFile"),
  gitReadBlobAtRef: mockRecord("gitReadBlobAtRef", "content"),
  gitLog: mockRecord("gitLog", []),
  gitFileHistory: mockRecord("gitFileHistory", []),
  gitBlame: mockRecord("gitBlame", []),
  gitCommit: mockRecord("gitCommit", "c0ffee"),
  gitMerge: mockRecord("gitMerge"),
  gitMergeAbort: mockRecord("gitMergeAbort"),
  gitRevert: mockRecord("gitRevert"),
}))
jest.mock("@/lib/task-workspace/user-action", () => ({
  approvalAwareTransport: { call: jest.fn() },
}))

import type { ScmHost } from "./host"
import {
  GIT_BACKEND,
  createGitSourceControlService,
  getSourceControlService,
  listSourceControlBackends,
  registerSourceControlBackend,
  type SourceControlService,
} from "./service"

beforeEach(() => {
  mockCalls.length = 0
})

describe("createGitSourceControlService", () => {
  const host = {
    captureChangeset: jest.fn(async () => ({ changesetId: "cs" })),
    rollbackIntegration: jest.fn(async () => ({ integrationId: "int" })),
  } as unknown as ScmHost
  const service = createGitSourceControlService(host)

  it("delegates repository operations to the routed git wrappers, local or remote target alike", async () => {
    const remote = "git-workspace:eyJ4IjoxfQ"
    await service.status(remote)
    await service.diffWorking("/repo", "a.ts", true)
    await service.diffRevisions("/repo", "main", "HEAD")
    await service.diffRevisionFile("/repo", "main", "HEAD", "a.ts")
    await expect(service.readFileAt("/repo", "main", "a.ts")).resolves.toBe("content")
    await service.blame("/repo", "a.ts", "abc")
    await expect(service.commit("/repo", "msg")).resolves.toBe("c0ffee")
    await service.commit("/repo", "msg", { amend: true, signoff: true })
    await service.merge("/repo", "feature")
    await service.abortMerge("/repo")
    await service.revert("/repo", "abc")
    await service.branches("/repo")
    await service.createBranch("/repo", "agent/x", "HEAD")
    expect(mockCalls).toEqual([
      ["gitStatus", [remote]],
      ["gitDiffFile", ["/repo", "a.ts", true]],
      ["gitDiffRefsFiles", ["/repo", "main", "HEAD"]],
      ["gitDiffRefsFile", ["/repo", "main", "HEAD", "a.ts"]],
      ["gitReadBlobAtRef", ["/repo", "main", "a.ts"]],
      ["gitBlame", ["/repo", "a.ts", "abc"]],
      ["gitCommit", ["/repo", "msg", false, false]],
      ["gitCommit", ["/repo", "msg", true, true]],
      ["gitMerge", ["/repo", "feature"]],
      ["gitMergeAbort", ["/repo"]],
      ["gitRevert", ["/repo", "abc"]],
      ["gitBranches", ["/repo"]],
      ["gitCreateBranch", ["/repo", "agent/x", false, "HEAD"]],
    ])
  })

  it("answers repository history and per-file history through one query", async () => {
    await service.history("/repo", { maxCount: 20, skip: 40 })
    await service.history("/repo", { maxCount: 10, path: "src/a.ts" })
    expect(mockCalls).toEqual([
      ["gitLog", ["/repo", 20, 40]],
      ["gitFileHistory", ["/repo", "src/a.ts", 10]],
    ])
  })

  it("snapshots through changeset capture and rolls back through the integration queue", async () => {
    await service.snapshot({ workspaceId: "ws", title: "t" })
    await service.rollback("int")
    expect(host.captureChangeset).toHaveBeenCalledWith({ workspaceId: "ws", title: "t" })
    expect(host.rollbackIntegration).toHaveBeenCalledWith("int")
    expect(service.changesets).toBe(host)
    expect(service.kind).toBe(GIT_BACKEND)
  })
})

describe("backend registry", () => {
  it("serves git by default and refuses unknown kinds", () => {
    expect(getSourceControlService().kind).toBe("git")
    expect(listSourceControlBackends()).toContain("git")
    expect(() => getSourceControlService("svn")).toThrow('no source-control backend "svn"')
  })

  it("registers another backend without shadowing one, and unregisters it", () => {
    const fake = { kind: "jj" } as SourceControlService
    const unregister = registerSourceControlBackend("jj", () => fake)
    expect(getSourceControlService("jj")).toBe(fake)
    expect(() => registerSourceControlBackend("jj", () => fake)).toThrow("already registered")
    expect(() => registerSourceControlBackend("git", () => fake)).toThrow("already registered")
    unregister()
    expect(listSourceControlBackends()).not.toContain("jj")
  })
})
