import {
  isMissingGithubCredential,
  MissingGithubCredentialError,
  resolveWorkspaceGithubBindings,
  runWorkspaceGithubSync,
  type WorkspaceGithubBinding,
} from "./sync-runner"
import type { IssueProject, IssueProjectResource } from "@/types/issues"

const mockListIssueProjects = jest.fn()
jest.mock("@/lib/db/issue-projects", () => ({
  listIssueProjects: (...args: unknown[]) => mockListIssueProjects(...args),
}))

const mockCreateResolveOctokit = jest.fn()
jest.mock("@/lib/ai/agent/team/pr-feedback/resolvers", () => ({
  createResolveOctokit: (...args: unknown[]) => mockCreateResolveOctokit(...args),
}))

function project(id: string, resources: IssueProjectResource[]): IssueProject {
  return {
    id,
    projectId: "ws-1",
    key: id.toUpperCase().slice(0, 4),
    name: id,
    status: "planned",
    priority: "none",
    resources,
    createdAt: 1,
    updatedAt: 1,
  }
}

const repo = (repoFullName: string): IssueProjectResource => ({
  kind: "github-repo",
  repoFullName,
  addedAt: 1,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockCreateResolveOctokit.mockReturnValue(async () => null)
})

describe("resolveWorkspaceGithubBindings", () => {
  it("projects every github-repo resource into a (repo, container) pair", async () => {
    mockListIssueProjects.mockResolvedValue([
      project("a", [repo("acme/one")]),
      project("b", [repo("acme/two")]),
    ])

    await expect(resolveWorkspaceGithubBindings("ws-1")).resolves.toEqual([
      { repoFullName: "acme/one", issueProjectId: "a" },
      { repoFullName: "acme/two", issueProjectId: "b" },
    ])
    expect(mockListIssueProjects).toHaveBeenCalledWith({ projectId: "ws-1" })
  })

  it("ignores workspace-root resources — only GitHub repos are syncable", async () => {
    mockListIssueProjects.mockResolvedValue([
      project("a", [{ kind: "workspace-root", rootId: "root-1", addedAt: 1 }, repo("acme/one")]),
    ])

    await expect(resolveWorkspaceGithubBindings("ws-1")).resolves.toEqual([
      { repoFullName: "acme/one", issueProjectId: "a" },
    ])
  })

  it("keeps ONE binding per repo — a mirror row can only belong to one container", async () => {
    mockListIssueProjects.mockResolvedValue([
      project("b", [repo("acme/one")]),
      project("a", [repo("acme/one")]),
    ])

    // Sorted by container id, so the winner is stable across runs rather than
    // whatever order Dexie happened to hand back.
    await expect(resolveWorkspaceGithubBindings("ws-1")).resolves.toEqual([
      { repoFullName: "acme/one", issueProjectId: "a" },
    ])
  })

  it("returns nothing for a workspace with no containers", async () => {
    mockListIssueProjects.mockResolvedValue([])
    await expect(resolveWorkspaceGithubBindings("ws-1")).resolves.toEqual([])
  })
})

describe("runWorkspaceGithubSync", () => {
  const bindings: WorkspaceGithubBinding[] = [{ repoFullName: "acme/one", issueProjectId: "a" }]

  it("does not touch the network when nothing is bound", async () => {
    const sync = jest.fn()
    const result = await runWorkspaceGithubSync(
      { projectId: "ws-1" },
      { resolveBindings: async () => [], sync }
    )

    expect(result).toEqual({ repoCount: 0, results: [], failures: [] })
    expect(sync).not.toHaveBeenCalled()
    // An unbound workspace is the normal state for most of the schedule's
    // life — it must not register as a failed execution.
    expect(result.failures).toHaveLength(0)
  })

  it("passes the resolved bindings through to the sync", async () => {
    const sync = jest.fn().mockResolvedValue({ results: [], failures: [] })
    const result = await runWorkspaceGithubSync(
      { projectId: "ws-1" },
      {
        resolveBindings: async () => bindings,
        resolveOctokitOrNull: async () => ({}) as never,
        sync,
      }
    )

    expect(sync).toHaveBeenCalledWith({ bindings }, expect.anything())
    expect(result.repoCount).toBe(1)
  })

  it("forwards `full` so Sync-now can bypass the watermark", async () => {
    const sync = jest.fn().mockResolvedValue({ results: [], failures: [] })
    await runWorkspaceGithubSync(
      { projectId: "ws-1", full: true },
      {
        resolveBindings: async () => bindings,
        resolveOctokitOrNull: async () => ({}) as never,
        sync,
      }
    )

    expect(sync).toHaveBeenCalledWith({ bindings, full: true }, expect.anything())
  })

  it("surfaces a missing credential as a per-repo failure, not a thrown run", async () => {
    const { syncWorkspaceRepos } =
      jest.requireActual<typeof import("./github-sync")>("./github-sync")

    // `full` skips the watermark/ETag reads, so the credential resolver is the
    // first thing the real sync touches — otherwise Dexie would throw first and
    // the assertion below would pass for the wrong reason.
    const result = await runWorkspaceGithubSync(
      { projectId: "ws-1", full: true },
      {
        resolveBindings: async () => bindings,
        resolveOctokitOrNull: async () => null,
        sync: syncWorkspaceRepos,
      }
    )

    expect(result.results).toHaveLength(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].repoFullName).toBe("acme/one")
    expect(result.failures[0].error).toBeInstanceOf(MissingGithubCredentialError)
    expect(isMissingGithubCredential(result.failures[0].error)).toBe(true)
  })

  it("does not mistake an ordinary failure for a missing credential", () => {
    expect(isMissingGithubCredential(new Error("network down"))).toBe(false)
    expect(isMissingGithubCredential("not an error")).toBe(false)
  })

  it("builds the credential resolver from the shared gh-CLI seam by default", async () => {
    const sync = jest.fn().mockResolvedValue({ results: [], failures: [] })
    await runWorkspaceGithubSync(
      { projectId: "ws-1" },
      { resolveBindings: async () => bindings, sync }
    )

    expect(mockCreateResolveOctokit).toHaveBeenCalledTimes(1)
  })
})
