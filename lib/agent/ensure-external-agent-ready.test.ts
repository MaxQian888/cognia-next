/**
 * @jest-environment jsdom
 */
import {
  __resetEnsureExternalAgentReadyForTests,
  ensureExternalAgentReady,
} from "./ensure-external-agent-ready"

const getAgent = jest.fn()
const recordAgentFailure = jest.fn()
const clearAgentFailure = jest.fn()
const setConnectionStatus = jest.fn()
const storeState = { getAgent, recordAgentFailure, clearAgentFailure, setConnectionStatus }
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: { getState: () => storeState },
}))

const blockReason = jest.fn<string | null, [unknown]>(() => null)
jest.mock("@/lib/ai/agent/external/config/config-normalizer", () => ({
  getExternalAgentExecutionBlockReason: (c: unknown) => blockReason(c),
}))

const managerGetAgent = jest.fn()
const managerAddAgent = jest.fn()
const managerConnect = jest.fn()
const managerReconnect = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getAgent: (...a: unknown[]) => managerGetAgent(...a),
    addAgent: (...a: unknown[]) => managerAddAgent(...a),
    connect: (...a: unknown[]) => managerConnect(...a),
    reconnect: (...a: unknown[]) => managerReconnect(...a),
  }),
}))

const placeAgentRun = jest.fn()
const agentNeedsRespawn = jest.fn(() => false)
jest.mock("@/lib/sandbox/run-environment", () => ({
  placeAgentRun: (...a: unknown[]) => placeAgentRun(...a),
  agentNeedsRespawn: (...a: unknown[]) => agentNeedsRespawn(...(a as [])),
}))
jest.mock("@/lib/sandbox/environment-outcome-message", () => ({
  outcomeMessage: async (outcome: { code: string }) => `localized:${outcome.code}`,
}))

const config = { id: "pi-1", name: "Pi", protocol: "pi-rpc" }

beforeEach(() => {
  jest.clearAllMocks()
  __resetEnsureExternalAgentReadyForTests()
  getAgent.mockReturnValue(config)
  blockReason.mockReturnValue(null)
  managerGetAgent.mockReturnValue(undefined)
  managerAddAgent.mockResolvedValue(undefined)
  managerConnect.mockResolvedValue(undefined)
  managerReconnect.mockResolvedValue(undefined)
  placeAgentRun.mockResolvedValue({ kind: "off" })
  agentNeedsRespawn.mockReturnValue(false)
})

describe("ensureExternalAgentReady", () => {
  it("registers a gateway task without launching the shared account environment", async () => {
    getAgent.mockReturnValue({
      ...config,
      cogniaModel: { providerId: "gateway", modelId: "coder" },
    })
    await expect(ensureExternalAgentReady("pi-1")).resolves.toEqual({
      ok: true,
      alreadyConnected: false,
    })
    expect(managerAddAgent).toHaveBeenCalled()
    expect(managerConnect).not.toHaveBeenCalled()
  })

  it("defers connection for a task-specific model override", async () => {
    await ensureExternalAgentReady("pi-1", { deferConnect: true })
    expect(managerAddAgent).toHaveBeenCalled()
    expect(managerConnect).not.toHaveBeenCalled()
  })
  it("registers an agent the manager has never been given, then connects it", async () => {
    // This is the gap that produced `Agent not found: <id>` on the first send:
    // the config was selectable while the manager's adapter map had no entry.
    const result = await ensureExternalAgentReady("pi-1")
    expect(managerAddAgent).toHaveBeenCalledWith(config, { connect: false })
    expect(managerConnect).toHaveBeenCalledWith("pi-1")
    expect(result).toEqual({ ok: true, alreadyConnected: false })
  })

  it("does not reconnect an agent that is already connected", async () => {
    managerGetAgent.mockReturnValue({ connectionStatus: "connected" })
    const result = await ensureExternalAgentReady("pi-1")
    expect(managerAddAgent).not.toHaveBeenCalled()
    expect(managerConnect).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, alreadyConnected: true })
  })

  it("refuses an id with no stored config rather than registering nothing", async () => {
    getAgent.mockReturnValue(undefined)
    await expect(ensureExternalAgentReady("gone")).resolves.toEqual({
      ok: false,
      reason: "unknown-agent",
    })
    expect(managerAddAgent).not.toHaveBeenCalled()
  })

  it("stops at the execution gate instead of starting a process it would refuse", async () => {
    blockReason.mockReturnValue("needs a runtime that can start a process")
    await expect(ensureExternalAgentReady("pi-1")).resolves.toEqual({
      ok: false,
      reason: "blocked",
      detail: "needs a runtime that can start a process",
    })
    expect(managerConnect).not.toHaveBeenCalled()
  })

  it("records a connect failure against the agent, where the panel draws it", async () => {
    managerConnect.mockRejectedValue(new Error("Could not determine the Pi version"))
    const result = await ensureExternalAgentReady("pi-1")
    expect(result).toEqual({
      ok: false,
      reason: "failed",
      detail: "Could not determine the Pi version",
    })
    expect(recordAgentFailure).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "pi-1", phase: "connect" })
    )
    expect(setConnectionStatus).toHaveBeenLastCalledWith("pi-1", "error")
  })

  it("treats a concurrent registration as a race, not a failure", async () => {
    managerAddAgent.mockRejectedValue(new Error("Agent already exists"))
    const result = await ensureExternalAgentReady("pi-1")
    expect(recordAgentFailure).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, alreadyConnected: false })
  })

  it("runs one attempt when the chip and a send ask in the same tick", async () => {
    // Connecting twice starts two processes.
    let release: () => void = () => {}
    managerConnect.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const first = ensureExternalAgentReady("pi-1")
    const second = ensureExternalAgentReady("pi-1")
    expect(first).toBe(second)
    release()
    await first
    expect(managerConnect).toHaveBeenCalledTimes(1)
  })

  it("shows the attempt as connecting while it runs", async () => {
    await ensureExternalAgentReady("pi-1")
    expect(setConnectionStatus.mock.calls.map((call) => call[1])).toContain("connecting")
  })
})

describe("ensureExternalAgentReady — the run's environment (ADR-0182)", () => {
  const environment = {
    projectId: "prj1",
    environmentId: "env-1",
    project: { roots: [{ id: "r1", path: "/repo", isPrimary: true }] },
    executionRoot: "/repo",
    surface: "interactive" as const,
  }

  // Q39: a caller that is not a project run resolves nothing at all.
  it("resolves nothing for a bare connect", async () => {
    await ensureExternalAgentReady("pi-1")
    expect(placeAgentRun).not.toHaveBeenCalled()
    expect(managerConnect).toHaveBeenCalledWith("pi-1")
  })

  it("resolves the environment for this agent before connecting", async () => {
    await expect(ensureExternalAgentReady("pi-1", { environment })).resolves.toEqual({
      ok: true,
      alreadyConnected: false,
    })
    expect(placeAgentRun).toHaveBeenCalledWith({ ...environment, agentId: "pi-1" })
    expect(placeAgentRun.mock.invocationCallOrder[0]).toBeLessThan(
      managerConnect.mock.invocationCallOrder[0]!
    )
  })

  // A refusal means running on the ordinary path would do less than asked,
  // so no process may start at all.
  it("refuses a run whose environment was refused, before any process starts", async () => {
    placeAgentRun.mockResolvedValue({ kind: "refused", code: "sandbox_pool_disabled", notices: [] })
    await expect(ensureExternalAgentReady("pi-1", { environment })).resolves.toEqual({
      ok: false,
      reason: "blocked",
      detail: "localized:sandbox_pool_disabled",
    })
    expect(managerConnect).not.toHaveBeenCalled()
    expect(managerReconnect).not.toHaveBeenCalled()
  })

  // Carrying on after a resolution that could not run would start an agent a
  // mandatory project never allowed on the host.
  it("fails, rather than connecting, when resolution itself throws", async () => {
    placeAgentRun.mockRejectedValue(new Error("dexie closed"))
    await expect(ensureExternalAgentReady("pi-1", { environment })).resolves.toEqual({
      ok: false,
      reason: "failed",
      detail: "dexie closed",
    })
    expect(managerConnect).not.toHaveBeenCalled()
    expect(recordAgentFailure).toHaveBeenCalled()
  })

  it("reuses a running agent that already runs where this run belongs", async () => {
    managerGetAgent.mockReturnValue({ connectionStatus: "connected" })
    await expect(ensureExternalAgentReady("pi-1", { environment })).resolves.toEqual({
      ok: true,
      alreadyConnected: true,
    })
    expect(managerReconnect).not.toHaveBeenCalled()
  })

  // The project changed environment while its agent kept running.
  it("restarts a running agent that runs somewhere else", async () => {
    managerGetAgent.mockReturnValue({ connectionStatus: "connected" })
    agentNeedsRespawn.mockReturnValue(true)

    await expect(ensureExternalAgentReady("pi-1", { environment })).resolves.toEqual({
      ok: true,
      alreadyConnected: false,
    })
    expect(managerReconnect).toHaveBeenCalledWith("pi-1")
    expect(managerConnect).not.toHaveBeenCalled()
  })

  // A bare connect answering "connected" must not stand in for a project run
  // whose environment nobody resolved.
  it("does not share an in-flight answer between a bare connect and a project run", async () => {
    const releases: Array<() => void> = []
    managerConnect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        })
    )
    const bare = ensureExternalAgentReady("pi-1")
    const scoped = ensureExternalAgentReady("pi-1", { environment })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Two attempts, not one shared: the project run resolved its environment.
    expect(placeAgentRun).toHaveBeenCalledTimes(1)
    expect(managerConnect).toHaveBeenCalledTimes(2)
    for (const release of releases) release()
    await Promise.all([bare, scoped])
  })
})

describe("ensureExternalAgentReady — never rejects", () => {
  it("turns an unexpected throw into a readiness the caller can render", async () => {
    // Every caller drives this from a click handler and cannot await it, so a
    // rejection escaping here is an unhandled one rather than something the
    // user is ever told about.
    blockReason.mockImplementation(() => {
      throw new Error("gate exploded")
    })
    await expect(ensureExternalAgentReady("pi-1")).resolves.toEqual({
      ok: false,
      reason: "failed",
      detail: "gate exploded",
    })
  })
})
