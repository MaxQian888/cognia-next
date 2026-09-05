import type { IssueProject } from "@/types/issues"
import { IssueSyncRegistry } from "./registry"
import { resolveWorkspaceSyncBindings, runWorkspaceIssueSync } from "./runner"
import type { IssueSyncBinding, IssueSyncProvider, ReconcileOutcome } from "./types"

function container(id: string, projectId = "w1"): IssueProject {
  return {
    id,
    projectId,
    key: id.toUpperCase(),
    name: id,
    status: "backlog",
    priority: "none",
    resources: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function binding(providerId: string, issueProjectId: string): IssueSyncBinding {
  return {
    providerId,
    projectId: "w1",
    issueProjectId,
    projectKey: issueProjectId.toUpperCase(),
    resource: { kind: "github-repo", repoFullName: "o/r", addedAt: 1 },
    key: `${providerId}:${issueProjectId}`,
  }
}

function provider(id: string, bindings: IssueSyncBinding[]): IssueSyncProvider {
  return {
    id,
    label: id,
    pullFields: [],
    pushFields: [],
    resolveBindings: () => bindings,
    pull: async () => ({ items: [], notModified: true }),
  }
}

const outcome = (b: IssueSyncBinding): ReconcileOutcome => ({
  binding: b,
  created: 1,
  updated: 0,
  pushed: 0,
  queued: 0,
  conflicts: 0,
  linked: 0,
  cycles: 0,
  notModified: false,
  truncated: false,
})

describe("resolveWorkspaceSyncBindings", () => {
  it("asks every registered provider, in registration order, with the scoped containers", async () => {
    const registry = new IssueSyncRegistry()
    const a = binding("a", "p1")
    const b = binding("b", "p1")
    registry.register(provider("a", [a]))
    registry.register(provider("b", [b]))
    const listContainers = jest.fn(async () => [container("p1")])
    const bindings = await resolveWorkspaceSyncBindings("w1", registry, listContainers as never)
    expect(bindings).toEqual([a, b])
    expect(listContainers).toHaveBeenCalledWith({ projectId: "w1" })
    await resolveWorkspaceSyncBindings(undefined, registry, listContainers as never)
    expect(listContainers).toHaveBeenLastCalledWith({})
  })
})

describe("runWorkspaceIssueSync", () => {
  it("runs the mirror, then every binding, isolating failures", async () => {
    const registry = new IssueSyncRegistry()
    const good = binding("a", "p1")
    const bad = binding("b", "p1")
    registry.register(provider("a", [good]))
    registry.register(provider("b", [bad]))
    const runMirror = jest.fn(async () => ({ repoCount: 2, results: [], failures: [] }))
    const reconcile = jest.fn(async (b: IssueSyncBinding) => {
      if (b.providerId === "b") throw new Error("boom")
      return outcome(b)
    })
    const result = await runWorkspaceIssueSync(
      { projectId: "w1", full: true },
      {
        registry,
        runMirror: runMirror as never,
        reconcile: reconcile as never,
        listContainers: (async () => [container("p1")]) as never,
      }
    )
    expect(runMirror).toHaveBeenCalledWith({ projectId: "w1", full: true })
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(reconcile.mock.calls[0][2]).toEqual({ full: true })
    expect(result.bindingCount).toBe(4)
    expect(result.outcomes).toHaveLength(1)
    expect(result.failures).toEqual([{ binding: bad, error: expect.any(Error) }])
  })

  it("can skip the mirror and narrow to one provider", async () => {
    const registry = new IssueSyncRegistry()
    registry.register(provider("a", [binding("a", "p1")]))
    registry.register(provider("b", [binding("b", "p1")]))
    const runMirror = jest.fn()
    const reconcile = jest.fn(async (b: IssueSyncBinding) => outcome(b))
    const result = await runWorkspaceIssueSync(
      { providerId: "b", mirror: false },
      {
        registry,
        runMirror: runMirror as never,
        reconcile: reconcile as never,
        listContainers: (async () => [container("p1")]) as never,
      }
    )
    expect(runMirror).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(result.bindingCount).toBe(1)
    expect(result.mirror.repoCount).toBe(0)
  })
})
