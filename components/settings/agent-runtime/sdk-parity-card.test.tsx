import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const values: Record<string, boolean> = {
  claudeSdkParityV1: false,
  claudeSdkSessionStore: false,
  claudeSdkCheckpoint: false,
  claudeSdkPrewarm: false,
}
const setAgentExecutionFlag = jest.fn((flag: string, value: boolean) => {
  values[flag] = value
})

jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  getAgentExecutionFlags: () => ({
    agentExecutionResolverV2: true,
    genericAgentHostCommands: false,
    gatewayAgentRouteTickets: false,
    headlessLlmGateway: false,
    experimentalAnthropicDeploymentAgentSdk: false,
    ...values,
  }),
  isAgentExecutionFlagEnabled: (flag: string) => values[flag] ?? false,
  setAgentExecutionFlag: (flag: string, value: boolean) => setAgentExecutionFlag(flag, value),
  subscribeToAgentExecutionFlags: () => () => {},
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/ai/agent/execution/resolve-agent-execution-spec", () => ({
  resolveAgentExecutionSpec: () => ({ spec: { id: "spec" } }),
}))
jest.mock("@/lib/ai/agent/execution/capability-snapshot", () => ({
  buildCapabilitySnapshot: () => ({
    counts: { native: 34, equivalent: 0, unsupported: 6, total: 40 },
  }),
}))

import { SdkParityCard } from "./sdk-parity-card"

beforeEach(() => {
  jest.clearAllMocks()
  for (const key of Object.keys(values)) values[key] = false
})

describe("SdkParityCard", () => {
  it("shows the shared capability snapshot and keeps risk flags behind the master flag", () => {
    render(<SdkParityCard />)
    expect(screen.getByText("34 / 40")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Session store" })).toBeDisabled()
    expect(screen.getByRole("switch", { name: "File checkpointing" })).toBeDisabled()
    expect(screen.getByRole("switch", { name: "Prewarm pool" })).toBeDisabled()
  })

  it("writes the master and child flags through the shared feature-flag store", async () => {
    values.claudeSdkParityV1 = true
    const user = userEvent.setup()
    render(<SdkParityCard />)

    await user.click(screen.getByRole("switch", { name: "Session store" }))
    expect(setAgentExecutionFlag).toHaveBeenCalledWith("claudeSdkSessionStore", true)
    await user.click(screen.getByRole("switch", { name: "Claude Agent SDK parity" }))
    expect(setAgentExecutionFlag).toHaveBeenCalledWith("claudeSdkParityV1", false)
  })
})
