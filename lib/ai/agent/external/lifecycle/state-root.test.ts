import {
  __setProcessPlaneDepsForTests,
  externalAgentProcessPlane,
} from "../capability/process-plane"

const agentInvoke = jest.fn()
jest.mock("../agent-transport", () => ({
  agentInvoke: (...args: unknown[]) => agentInvoke(...args),
}))

import {
  getExternalAgentStateRootInfo,
  removeExternalAgentStateRoot,
  STATE_ROOT_INFO_COMMAND,
  STATE_ROOT_REMOVE_COMMAND,
} from "./state-root"

function local(): () => void {
  return __setProcessPlaneDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalProcessTable: () => true,
  })
}

/** A remote Host is selected and fully able to run agents for this device. */
function remote(): () => void {
  return __setProcessPlaneDepsForTests({
    isRemoteHostActive: () => true,
    hasLocalProcessTable: () => true,
    activeHostFeatureManifest: () =>
      ({
        schemaVersion: 1,
        features: { "external-agent.process-plane": { version: 1, operations: [] } },
      }) as never,
  })
}

function nowhere(): () => void {
  return __setProcessPlaneDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalProcessTable: () => false,
    getRuntimeSnapshot: () => ({ target: null, host: null }) as never,
  })
}

describe("external agent state root client", () => {
  let restore: () => void = () => {}
  afterEach(() => {
    restore()
    agentInvoke.mockReset()
  })

  it("asks the local host for a configuration's root", async () => {
    restore = local()
    agentInvoke.mockResolvedValue({
      path: "/data/cognia/external-agents/c1",
      exists: true,
      bytes: 42,
    })
    await expect(getExternalAgentStateRootInfo("c1")).resolves.toEqual({
      path: "/data/cognia/external-agents/c1",
      exists: true,
      bytes: 42,
    })
    expect(agentInvoke).toHaveBeenCalledWith(STATE_ROOT_INFO_COMMAND, { key: "c1" })
  })

  it("removes through the local host and reports that it did", async () => {
    restore = local()
    agentInvoke.mockResolvedValue(undefined)
    await expect(removeExternalAgentStateRoot("c1")).resolves.toBe(true)
    expect(agentInvoke).toHaveBeenCalledWith(STATE_ROOT_REMOVE_COMMAND, { key: "c1" })
  })

  it("propagates a host failure instead of reporting a delete that did not happen", async () => {
    restore = local()
    agentInvoke.mockRejectedValue(new Error("permission denied"))
    await expect(removeExternalAgentStateRoot("c1")).rejects.toThrow("permission denied")
  })

  it("refuses a malformed host answer", async () => {
    restore = local()
    for (const answer of [
      null,
      { path: "/p", exists: "yes", bytes: 1 },
      { path: "/p", exists: true, bytes: -1 },
    ]) {
      agentInvoke.mockResolvedValueOnce(answer)
      await expect(getExternalAgentStateRootInfo("c1")).rejects.toThrow(/malformed/)
    }
  })

  it.each([
    ["no process table and nothing paired", nowhere],
    ["a remote Host selected (its roots are its own)", remote],
  ])("does nothing with %s", async (label, setup) => {
    restore = setup()
    // The remote fixture must really be a reachable Host, or this case would
    // pass for the same reason as the first one.
    if (label.startsWith("a remote")) {
      expect(externalAgentProcessPlane()).toEqual({ ok: true, via: "remote" })
    }
    await expect(getExternalAgentStateRootInfo("c1")).resolves.toBeNull()
    await expect(removeExternalAgentStateRoot("c1")).resolves.toBe(false)
    expect(agentInvoke).not.toHaveBeenCalled()
  })

  it("never sends an id no spawn backend would accept as a key", async () => {
    restore = local()
    for (const id of ["", "../x", "a/b", "x".repeat(129)]) {
      await expect(getExternalAgentStateRootInfo(id)).resolves.toBeNull()
      await expect(removeExternalAgentStateRoot(id)).resolves.toBe(false)
    }
    expect(agentInvoke).not.toHaveBeenCalled()
  })
})
