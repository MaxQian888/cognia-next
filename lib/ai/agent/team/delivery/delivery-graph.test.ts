import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createDeliveryGraphService, type ScmDeliveryAdapter } from "./delivery-graph"

function adapter(): jest.Mocked<ScmDeliveryAdapter> {
  return {
    createPullRequest: jest.fn(async (input) => ({
      number: input.order + 10,
      url: `https://github.test/${input.repositoryId}/${input.order + 10}`,
      headSha: `sha-${input.order}`,
    })),
    observe: jest.fn(async (_node) => ({
      headSha: _node.headSha,
      ci: "passing" as const,
      approved: true,
      mergeable: true,
      conflict: false,
    })),
    retarget: jest.fn(async (_node, _baseBranch) => undefined),
    updateBranch: jest.fn(async (_node) => undefined),
    merge: jest.fn(async (_node) => undefined),
  }
}

describe("AgentTeam stacked delivery graph", () => {
  let disableDbRuntime: (() => void) | undefined

  async function draft(scm: ScmDeliveryAdapter) {
    const service = createDeliveryGraphService({ adapter: scm, now: () => 50 })
    await service.create({
      id: "graph",
      runId: "run",
      repositories: [
        {
          repositoryId: "primary",
          baseBranch: "main",
          layers: [
            { id: "a", branch: "a", title: "A" },
            { id: "b", branch: "b", title: "B" },
          ],
        },
      ],
    })
    return service
  }

  it("invalidates approval when the observed head changes", async () => {
    const scm = adapter()
    const service = await draft(scm)
    await service.publish("graph")
    await service.approve("graph")
    scm.observe.mockResolvedValueOnce({
      headSha: "new-sha",
      ci: "passing",
      approved: true,
      mergeable: true,
      conflict: false,
    })
    await expect(service.merge("graph")).rejects.toThrow(/changed.*approval/i)
    expect(scm.merge).not.toHaveBeenCalled()
    expect((await getDb().agentTeamDeliveryGraphs.get("graph"))?.approvedAt).toBeUndefined()
  })

  it("does not overwrite another graph's node or leave a graph after creation fails", async () => {
    const service = await draft(adapter())
    await expect(
      service.create({
        id: "other-graph",
        runId: "other-run",
        repositories: [
          {
            repositoryId: "other",
            baseBranch: "main",
            layers: [
              { id: "a", branch: "other-a", title: "Other A" },
              { id: "other-b", branch: "other-b", title: "Other B" },
            ],
          },
        ],
      })
    ).rejects.toThrow()
    expect(await getDb().agentTeamDeliveryGraphs.get("other-graph")).toBeUndefined()
    expect(await getDb().agentTeamDeliveryNodes.get("a")).toMatchObject({
      graphId: "graph",
      branch: "a",
    })
  })

  it("does not restore stale nodes when delivery changes during approval observation", async () => {
    const scm = adapter()
    const service = await draft(scm)
    await service.publish("graph")
    const observe = scm.observe.getMockImplementation()!
    scm.observe.mockImplementationOnce(async (node) => {
      await getDb().agentTeamDeliveryNodes.update(node.id, { status: "merged" })
      return observe(node)
    })
    await expect(service.approve("graph")).rejects.toThrow(/changed.*approval/i)
    expect(await getDb().agentTeamDeliveryNodes.get("a")).toMatchObject({ status: "merged" })
    expect((await getDb().agentTeamDeliveryGraphs.get("graph"))?.approvedAt).toBeUndefined()
  })

  it("resumes partial publication without recreating the persisted PR", async () => {
    const scm = adapter()
    const create = scm.createPullRequest.getMockImplementation()!
    scm.createPullRequest
      .mockImplementationOnce(create)
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(create)
    const service = await draft(scm)
    await expect(service.publish("graph")).rejects.toThrow("offline")
    await service.publish("graph")
    expect(scm.createPullRequest.mock.calls.map(([input]) => input.branch)).toEqual(["a", "b", "b"])
  })

  it("resumes partial merge and never merges a completed layer twice", async () => {
    const scm = adapter()
    scm.merge
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined)
    const service = await draft(scm)
    await service.publish("graph")
    await service.approve("graph")
    await expect(service.merge("graph")).rejects.toThrow("offline")
    await expect(service.merge("graph")).resolves.toMatchObject({ status: "completed" })
    expect(scm.merge.mock.calls.map(([node]) => node.id)).toEqual(["a", "b", "b"])
  })

  it("requires fresh approval after updating a later layer changes its revision", async () => {
    const scm = adapter()
    const service = await draft(scm)
    await service.publish("graph")
    await service.approve("graph")
    let changed = false
    scm.updateBranch.mockImplementation(async () => {
      changed = true
    })
    scm.observe.mockImplementation(async (node) => ({
      headSha: node.id === "b" && changed ? "sha-new" : node.headSha,
      ci: "passing",
      approved: true,
      mergeable: true,
      conflict: false,
    }))
    await expect(service.merge("graph")).rejects.toThrow(/changed.*approval/i)
    expect(scm.merge.mock.calls.map(([node]) => node.id)).toEqual(["a"])
    await service.approve("graph")
    await expect(service.merge("graph")).resolves.toMatchObject({ status: "completed" })
    expect(scm.merge.mock.calls.map(([node]) => [node.id, node.approvedHeadSha])).toEqual([
      ["a", "sha-0"],
      ["b", "sha-new"],
    ])
  })

  it("reconciles a remotely merged layer after an uncertain response", async () => {
    const scm = adapter()
    const service = await draft(scm)
    await service.publish("graph")
    await service.approve("graph")
    scm.observe.mockResolvedValueOnce({
      headSha: "sha-0",
      merged: true,
      ci: "unknown",
      approved: false,
      mergeable: false,
      conflict: false,
    })
    await expect(service.merge("graph")).resolves.toMatchObject({ status: "completed" })
    expect(scm.merge.mock.calls.map(([node]) => node.id)).toEqual(["b"])
  })

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("publishes a stack with each PR based on the preceding branch", async () => {
    const scm = adapter()
    const service = createDeliveryGraphService({ adapter: scm, now: () => 10 })
    const graph = await service.create({
      id: "graph-1",
      runId: "run-1",
      repositories: [
        {
          repositoryId: "primary",
          baseBranch: "main",
          layers: [
            { id: "layer-1", branch: "agent/layer-1", title: "Layer 1" },
            { id: "layer-2", branch: "agent/layer-2", title: "Layer 2" },
          ],
        },
      ],
    })

    await service.publish(graph.id)

    expect(scm.createPullRequest.mock.calls.map(([input]) => input.baseBranch)).toEqual([
      "main",
      "agent/layer-1",
    ])
    expect(await getDb().agentTeamDeliveryNodes.where("graphId").equals(graph.id).count()).toBe(2)
  })

  it("merges an approved stack bottom-up and retargets later layers", async () => {
    const scm = adapter()
    const service = createDeliveryGraphService({ adapter: scm, now: () => 20 })
    const graph = await service.create({
      id: "graph-2",
      runId: "run-2",
      repositories: [
        {
          repositoryId: "primary",
          baseBranch: "main",
          layers: [
            { id: "layer-1", branch: "agent/layer-1", title: "Layer 1" },
            { id: "layer-2", branch: "agent/layer-2", title: "Layer 2" },
          ],
        },
      ],
    })
    await service.publish(graph.id)
    await service.approve(graph.id)

    const result = await service.merge(graph.id)

    expect(result.status).toBe("completed")
    expect(scm.merge.mock.calls.map(([node]) => node.id)).toEqual(["layer-1", "layer-2"])
    expect(scm.retarget).toHaveBeenCalledWith(expect.objectContaining({ id: "layer-2" }), "main")
    expect(scm.updateBranch).toHaveBeenCalledWith(expect.objectContaining({ id: "layer-2" }))
  })

  it("stops before merging when CI fails", async () => {
    const scm = adapter()
    scm.observe.mockImplementation(async (node) => ({
      headSha: node.headSha,
      ci: "failing",
      approved: true,
      mergeable: false,
      conflict: false,
    }))
    const service = createDeliveryGraphService({ adapter: scm, now: () => 30 })
    const graph = await service.create({
      id: "graph-3",
      runId: "run-3",
      repositories: [
        {
          repositoryId: "primary",
          baseBranch: "main",
          layers: [
            { id: "layer-1", branch: "agent/layer-1", title: "Layer 1" },
            { id: "layer-2", branch: "agent/layer-2", title: "Layer 2" },
          ],
        },
      ],
    })
    await service.publish(graph.id)
    await service.approve(graph.id)

    await expect(service.merge(graph.id)).rejects.toThrow(/CI is not passing/)
    expect(scm.merge).not.toHaveBeenCalled()
  })

  it("runs a bounded remediation turn and rechecks the layer before merging", async () => {
    const scm = adapter()
    const observe = scm.observe.getMockImplementation()!
    scm.observe.mockImplementation(observe)
    const failure = {
      headSha: "sha-0",
      ci: "failing",
      approved: true,
      mergeable: false,
      conflict: true,
    } as const
    const remediate = jest.fn(async () => undefined)
    const service = createDeliveryGraphService({
      adapter: scm,
      remediate,
      maxRemediationAttempts: 1,
      now: () => 35,
    })
    const graph = await service.create({
      id: "graph-remediate",
      runId: "run-remediate",
      repositories: [
        {
          repositoryId: "primary",
          baseBranch: "main",
          layers: [
            { id: "layer-remediate-1", branch: "agent/remediate-1", title: "Layer 1" },
            { id: "layer-remediate-2", branch: "agent/remediate-2", title: "Layer 2" },
          ],
        },
      ],
    })
    await service.publish(graph.id)
    await service.approve(graph.id)

    scm.observe.mockResolvedValueOnce(failure)

    await expect(service.merge(graph.id)).resolves.toMatchObject({ status: "completed" })
    expect(remediate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "layer-remediate-1" }),
      expect.objectContaining({ ci: "failing", conflict: true }),
      1
    )
    expect(scm.observe).toHaveBeenCalledTimes(6)
  })

  it("orders a dependency repository after the dependency stack", async () => {
    const scm = adapter()
    const service = createDeliveryGraphService({ adapter: scm, now: () => 40 })
    const graph = await service.create({
      id: "graph-4",
      runId: "run-4",
      repositories: [
        {
          repositoryId: "dep",
          baseBranch: "main",
          layers: [
            { id: "dep-1", branch: "dep/1", title: "Dependency 1" },
            { id: "dep-2", branch: "dep/2", title: "Dependency 2" },
          ],
        },
        {
          repositoryId: "primary",
          baseBranch: "main",
          dependsOn: ["dep"],
          layers: [
            { id: "primary-1", branch: "primary/1", title: "Primary 1" },
            { id: "primary-2", branch: "primary/2", title: "Primary 2" },
          ],
        },
      ],
    })
    await service.publish(graph.id)
    await service.approve(graph.id)
    await service.merge(graph.id)

    expect(scm.merge.mock.calls.map(([node]) => node.id)).toEqual([
      "dep-1",
      "dep-2",
      "primary-1",
      "primary-2",
    ])
  })
})
