jest.mock("./environment-outcome-message", () => ({
  outcomeMessage: async () => "Approve this project's environment first.",
}))

import type { SandboxPlacementOutcome } from "./environment-placement"
import {
  ensureHostAgentPlacement,
  placeDispatchedAgent,
  placeHostAgentRun,
  type HostAgentPlacementSources,
} from "./host-agent-placement"
import type { RunEnvironmentSources } from "./run-environment"
import {
  __resetSpawnPlacementsForTests,
  registerSpawnPlacement,
  withSpawnPlacement,
} from "./spawn-placement-registry"

/** A spawn of `agentId` that went out with `placement` attached. */
function spawnedIn(agentId: string, placement: never): void {
  registerSpawnPlacement(agentId, placement)
  withSpawnPlacement({ config: { id: agentId } })
}

const placement = { kind: "container", spec: { specDigest: "sha256:abc" } } as never
const placed: SandboxPlacementOutcome = { kind: "placed", placement, notices: [] }

const PROJECTS = [
  {
    id: "repo",
    roots: [{ id: "r1", path: "/workspaces/repo", isPrimary: true }],
    defaultEnvironmentId: "env-default",
  },
  {
    id: "nested",
    roots: [{ id: "r2", path: "/workspaces/repo/packages/app", isPrimary: true }],
  },
] as never

function sources(overrides: Partial<HostAgentPlacementSources> = {}) {
  const base = {
    selection: jest.fn(async () => ({ runtime: undefined, policy: undefined })),
  } as unknown as RunEnvironmentSources
  const place = jest.fn(
    async (
      _request: Parameters<HostAgentPlacementSources["place"]>[0],
      _sources: RunEnvironmentSources
    ) => placed
  )
  const runOnHost = jest.fn(async () => undefined)
  const all: HostAgentPlacementSources = {
    isHost: () => true,
    projects: async () => PROJECTS,
    selection: async () => ({ runtime: undefined, policy: undefined }),
    runEnvironment: async () => base,
    place,
    runOnHost,
    ...overrides,
  }
  return { all, place, runOnHost }
}

describe("placeHostAgentRun", () => {
  it("does nothing off an always-on host", async () => {
    const { all, place, runOnHost } = sources({ isHost: () => false })
    await expect(placeHostAgentRun({ agentId: "a", projectId: "repo" }, all)).resolves.toEqual({
      kind: "not-a-host",
    })
    expect(place).not.toHaveBeenCalled()
    expect(runOnHost).not.toHaveBeenCalled()
  })

  it("places a run in its project's environment, the deployment default without one", async () => {
    const { all, place } = sources()
    await expect(
      placeHostAgentRun({ agentId: "a", projectId: "repo", cwd: "/workspaces/repo" }, all)
    ).resolves.toEqual({ kind: "resolved", outcome: placed })
    const [request, runEnvironment] = place.mock.calls[0]
    expect(request).toEqual({
      agentId: "a",
      projectId: "repo",
      environmentId: "env-default",
      project: PROJECTS[0],
      executionRoot: "/workspaces/repo",
      surface: "unattended",
    })
    await expect(runEnvironment.selection("repo")).resolves.toMatchObject({
      runtime: { source: { kind: "auto" } },
    })
  })

  it("finds the project by the closest root holding the working directory", async () => {
    const { all, place } = sources()
    await placeHostAgentRun({ agentId: "a", cwd: "/workspaces/repo/packages/app/src" }, all)
    expect(place.mock.calls[0][0]).toMatchObject({ projectId: "nested" })
    await placeHostAgentRun({ agentId: "b", cwd: "/workspaces/repo/docs" }, all)
    expect(place.mock.calls[1][0]).toMatchObject({ projectId: "repo" })
    // A lease's working copy is found by the checkout it was taken from.
    await placeHostAgentRun(
      { agentId: "c", cwd: "/workspaces/.exec/run-1", projectPath: "/workspaces/repo" },
      all
    )
    expect(place.mock.calls[2][0]).toMatchObject({
      projectId: "repo",
      executionRoot: "/workspaces/.exec/run-1",
    })
  })

  it("keeps a run with no project, or an opted-out project, on the host path", async () => {
    const none = sources()
    await expect(
      placeHostAgentRun({ agentId: "a", cwd: "/somewhere/else" }, none.all)
    ).resolves.toEqual({ kind: "host-process", reason: "no-project" })
    expect(none.runOnHost).toHaveBeenCalledWith("a")
    expect(none.place).not.toHaveBeenCalled()

    const optedOut = sources({
      selection: async () => ({
        runtime: { source: { kind: "auto" }, hostProcess: true, updatedAt: 1 },
        policy: undefined,
      }),
    })
    await expect(
      placeHostAgentRun({ agentId: "a", projectId: "repo" }, optedOut.all)
    ).resolves.toEqual({ kind: "host-process", reason: "opted-out" })
    expect(optedOut.runOnHost).toHaveBeenCalledWith("a")
    expect(optedOut.place).not.toHaveBeenCalled()
  })

  it("does not read an unreadable selection as an opt-out", async () => {
    const { all, place } = sources({
      selection: async () => {
        throw new Error("vault locked")
      },
    })
    await expect(placeHostAgentRun({ agentId: "a", projectId: "repo" }, all)).resolves.toEqual({
      kind: "resolved",
      outcome: placed,
    })
    expect(place).toHaveBeenCalled()
  })
})

describe("ensureHostAgentPlacement", () => {
  afterEach(() => __resetSpawnPlacementsForTests())

  const manager = (status?: string) => ({
    getAgent: jest.fn(() => (status ? { connectionStatus: status } : undefined)),
    reconnect: jest.fn(async () => undefined),
  })

  it("refuses the run before anything starts when its environment is refused", async () => {
    const { all } = sources({
      place: async () => ({
        kind: "refused",
        code: "environment_approval_pending",
        notices: [],
      }),
    })
    const m = manager("connected")
    await expect(
      ensureHostAgentPlacement({ agentId: "a", projectId: "repo" }, m, all)
    ).rejects.toMatchObject({
      name: "RunEnvironmentRefusedError",
      code: "environment_approval_pending",
      message: "Approve this project's environment first.",
    })
    expect(m.reconnect).not.toHaveBeenCalled()
  })

  it("restarts a connected agent that runs somewhere else, and only that", async () => {
    // Running on the host (no spawn record), now placed in a container.
    const m = manager("connected")
    await ensureHostAgentPlacement({ agentId: "a", projectId: "repo" }, m, sources().all)
    expect(m.reconnect).toHaveBeenCalledWith("a")

    // Not connected yet: the next connect picks the placement up by itself.
    const idle = manager("disconnected")
    await ensureHostAgentPlacement({ agentId: "b", projectId: "repo" }, idle, sources().all)
    expect(idle.reconnect).not.toHaveBeenCalled()

    // Already running in exactly that placement.
    spawnedIn("c", placement)
    const same = manager("connected")
    await ensureHostAgentPlacement({ agentId: "c", projectId: "repo" }, same, sources().all)
    expect(same.reconnect).not.toHaveBeenCalled()
  })

  it("brings a containerized agent back to the host when its run belongs there", async () => {
    spawnedIn("a", placement)
    const m = manager("connected")
    await ensureHostAgentPlacement({ agentId: "a", cwd: "/no/project" }, m, sources().all)
    expect(m.reconnect).toHaveBeenCalledWith("a")
  })

  it("is a no-op off an always-on host", async () => {
    const m = manager("connected")
    await expect(
      ensureHostAgentPlacement({ agentId: "a" }, m, sources({ isHost: () => false }).all)
    ).resolves.toEqual({ kind: "not-a-host" })
    expect(m.reconnect).not.toHaveBeenCalled()
  })
})

describe("placeDispatchedAgent", () => {
  const globals = globalThis as Record<string, unknown>
  afterEach(() => {
    delete globals.__COGNIA_HEADLESS__
    __resetSpawnPlacementsForTests()
  })

  it("returns without touching anything off an always-on host", async () => {
    const m = { getAgent: jest.fn(), reconnect: jest.fn() }
    await placeDispatchedAgent("a", "/workspaces/repo", m)
    expect(m.getAgent).not.toHaveBeenCalled()
  })

  it("on an always-on host brings an agent with no project back from a container", async () => {
    globals.__COGNIA_HEADLESS__ = true
    spawnedIn("a", placement)
    const m = {
      getAgent: jest.fn(() => ({ connectionStatus: "connected" })),
      reconnect: jest.fn(async () => undefined),
    }
    // No project holds this directory (the project store is empty here).
    await placeDispatchedAgent("a", "/tmp/elsewhere", m)
    expect(m.reconnect).toHaveBeenCalledWith("a")
  })
})
