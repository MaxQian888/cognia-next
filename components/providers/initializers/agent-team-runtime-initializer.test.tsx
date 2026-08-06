/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react"

const configureAgentTeamRuntime = jest.fn()
const recoverDurableAgentTeams = jest.fn(() => Promise.resolve([]))
const buildAgentTeamRuntimeDeps = jest.fn(() => ({ runtime: true }))
const hasHydrated = jest.fn(() => true)
const onFinishHydration = jest.fn()

jest.mock("@/lib/ai/agent/agent-team", () => ({
  configureAgentTeamRuntime: (deps: unknown) => configureAgentTeamRuntime(deps),
  recoverDurableAgentTeams: () => recoverDurableAgentTeams(),
}))

jest.mock("@/lib/ai/agent/agent-team-runtime-deps", () => ({
  buildAgentTeamRuntimeDeps: () => buildAgentTeamRuntimeDeps(),
}))

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: {
    persist: {
      hasHydrated: () => hasHydrated(),
      onFinishHydration: (callback: () => void) => onFinishHydration(callback),
    },
  },
}))

import { AgentTeamRuntimeInitializer } from "./agent-team-runtime-initializer"

describe("AgentTeamRuntimeInitializer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    hasHydrated.mockReturnValue(true)
    recoverDurableAgentTeams.mockResolvedValue([])
  })

  it("configures the runtime and recovers immediately after hydration", async () => {
    render(<AgentTeamRuntimeInitializer />)

    expect(buildAgentTeamRuntimeDeps).toHaveBeenCalledTimes(1)
    expect(configureAgentTeamRuntime).toHaveBeenCalledWith({ runtime: true })
    await waitFor(() => expect(recoverDurableAgentTeams).toHaveBeenCalledTimes(1))
  })

  it("defers recovery until persisted teams finish hydrating", async () => {
    hasHydrated.mockReturnValue(false)
    let finishHydration: (() => void) | undefined
    const unsubscribe = jest.fn()
    onFinishHydration.mockImplementation((callback: () => void) => {
      finishHydration = callback
      return unsubscribe
    })

    const view = render(<AgentTeamRuntimeInitializer />)
    expect(recoverDurableAgentTeams).not.toHaveBeenCalled()

    finishHydration?.()
    await waitFor(() => expect(recoverDurableAgentTeams).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("contains recovery failures because startup must remain available", async () => {
    recoverDurableAgentTeams.mockRejectedValue(new Error("recovery failed"))

    expect(() => render(<AgentTeamRuntimeInitializer />)).not.toThrow()
    await waitFor(() => expect(recoverDurableAgentTeams).toHaveBeenCalledTimes(1))
  })
})
