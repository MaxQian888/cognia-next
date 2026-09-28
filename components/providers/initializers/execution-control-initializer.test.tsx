import { render } from "@testing-library/react"

const release = jest.fn()
const install = jest.fn(() => release)
const stopBridge = jest.fn()
const startBridge = jest.fn(() => stopBridge)
let mockAccountRevision = 0
jest.mock("@/lib/execution/agent-state-bridge", () => ({
  startAgentStateExecutionBridge: () => startBridge(),
}))
let mockTargetId: string | null = "web-standalone"
let mockVaultState = "unlocked"
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({ target: { id: mockTargetId }, vaultState: mockVaultState }),
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { accountRevision: number }) => unknown) =>
    selector({ accountRevision: mockAccountRevision }),
}))

jest.mock("@/lib/execution/install-execution-control", () => ({
  installExecutionControlPlane: () => install(),
}))

import { ExecutionControlInitializer } from "./execution-control-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  mockAccountRevision = 0
  mockTargetId = "web-standalone"
  mockVaultState = "unlocked"
})

it("renders nothing", () => {
  const { container } = render(<ExecutionControlInitializer />)
  expect(container).toBeEmptyDOMElement()
})

it("installs the control plane on mount", () => {
  render(<ExecutionControlInitializer />)
  expect(install).toHaveBeenCalledTimes(1)
})

it("releases its reference on unmount", () => {
  const { unmount } = render(<ExecutionControlInitializer />)
  expect(release).not.toHaveBeenCalled()
  unmount()
  expect(release).toHaveBeenCalledTimes(1)
})

it("does not reinstall on re-render", () => {
  const { rerender } = render(<ExecutionControlInitializer />)
  rerender(<ExecutionControlInitializer />)
  expect(install).toHaveBeenCalledTimes(1)
})

it("owns the portable goal/plan journal and restarts it on account revision", () => {
  const { rerender, unmount } = render(<ExecutionControlInitializer />)
  expect(startBridge).toHaveBeenCalledTimes(1)
  mockAccountRevision += 1
  rerender(<ExecutionControlInitializer />)
  expect(stopBridge).toHaveBeenCalledTimes(1)
  expect(startBridge).toHaveBeenCalledTimes(2)
  expect(install).toHaveBeenCalledTimes(1)
  unmount()
  expect(stopBridge).toHaveBeenCalledTimes(2)
})

it("rebinds on a host switch and releases the journal while the vault is locked", () => {
  const { rerender } = render(<ExecutionControlInitializer />)
  mockTargetId = "paired-host"
  rerender(<ExecutionControlInitializer />)
  expect(startBridge).toHaveBeenCalledTimes(2)
  expect(stopBridge).toHaveBeenCalledTimes(1)
  mockVaultState = "locked"
  rerender(<ExecutionControlInitializer />)
  expect(stopBridge).toHaveBeenCalledTimes(2)
  expect(startBridge).toHaveBeenCalledTimes(2)
  mockVaultState = "unlocked"
  rerender(<ExecutionControlInitializer />)
  expect(startBridge).toHaveBeenCalledTimes(3)
})

it("waits for an unlocked selected target and releases on logout", () => {
  mockVaultState = "locked"
  const { rerender } = render(<ExecutionControlInitializer />)
  expect(startBridge).not.toHaveBeenCalled()
  mockVaultState = "unlocked"
  rerender(<ExecutionControlInitializer />)
  expect(startBridge).toHaveBeenCalledTimes(1)
  mockTargetId = null
  mockVaultState = "unavailable"
  rerender(<ExecutionControlInitializer />)
  expect(stopBridge).toHaveBeenCalledTimes(1)
  expect(startBridge).toHaveBeenCalledTimes(1)
})
