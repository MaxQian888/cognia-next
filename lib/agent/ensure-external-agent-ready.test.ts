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
jest.mock("@/lib/ai/agent/external/config-normalizer", () => ({
  getExternalAgentExecutionBlockReason: (c: unknown) => blockReason(c),
}))

const managerGetAgent = jest.fn()
const managerAddAgent = jest.fn()
const managerConnect = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getAgent: (...a: unknown[]) => managerGetAgent(...a),
    addAgent: (...a: unknown[]) => managerAddAgent(...a),
    connect: (...a: unknown[]) => managerConnect(...a),
  }),
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
})

describe("ensureExternalAgentReady", () => {
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
