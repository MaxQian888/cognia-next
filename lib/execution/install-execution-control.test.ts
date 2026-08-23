/**
 * The regression these pin: run control used to die with the connector
 * runtime. A second owner must be able to hold the dispatch table open when
 * the connector runtime releases its lease.
 */

const dispose = jest.fn()
const installHandlers = jest.fn(() => ({ dispose }))

jest.mock("./control-handlers", () => ({
  installExecutionRunControlHandlers: (...args: unknown[]) => installHandlers(...(args as [])),
}))

import {
  __resetExecutionControlPlaneForTesting,
  installExecutionControlPlane,
  isExecutionControlPlaneInstalled,
} from "./install-execution-control"

beforeEach(() => {
  __resetExecutionControlPlaneForTesting()
  jest.clearAllMocks()
})

it("installs the handlers on first reference", () => {
  expect(isExecutionControlPlaneInstalled()).toBe(false)
  installExecutionControlPlane()
  expect(installHandlers).toHaveBeenCalledTimes(1)
  expect(isExecutionControlPlaneInstalled()).toBe(true)
})

it("does not reinstall for a second owner", () => {
  installExecutionControlPlane()
  installExecutionControlPlane()
  expect(installHandlers).toHaveBeenCalledTimes(1)
})

it("keeps the table installed until the LAST owner releases", () => {
  const releaseConnectorRuntime = installExecutionControlPlane()
  const releaseInitializer = installExecutionControlPlane()

  // The connector runtime losing its lease must not disarm run control.
  releaseConnectorRuntime()
  expect(dispose).not.toHaveBeenCalled()
  expect(isExecutionControlPlaneInstalled()).toBe(true)

  releaseInitializer()
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(isExecutionControlPlaneInstalled()).toBe(false)
})

it("treats a repeated release as one reference (StrictMode double-cleanup)", () => {
  const releaseA = installExecutionControlPlane()
  const releaseB = installExecutionControlPlane()

  releaseA()
  releaseA()
  releaseA()

  // Still held by B — a double-invoked cleanup must not drop someone else's ref.
  expect(dispose).not.toHaveBeenCalled()
  releaseB()
  expect(dispose).toHaveBeenCalledTimes(1)
})

it("reinstalls after a full teardown", () => {
  installExecutionControlPlane()()
  expect(dispose).toHaveBeenCalledTimes(1)

  installExecutionControlPlane()
  expect(installHandlers).toHaveBeenCalledTimes(2)
  expect(isExecutionControlPlaneInstalled()).toBe(true)
})

it("forwards deps to the handler factory", () => {
  const resumeAgentRun = jest.fn()
  installExecutionControlPlane({ resumeAgentRun })
  expect(installHandlers).toHaveBeenCalledWith({ resumeAgentRun })
})
