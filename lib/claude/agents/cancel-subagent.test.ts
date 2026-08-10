const requestCancel = jest.fn((..._a: unknown[]) => true)
const cancelBackground = jest.fn((..._a: unknown[]) => true)
const setStatus = jest.fn()

jest.mock("./subagent-cancel-registry", () => ({
  requestCancelSubagentRun: (...a: unknown[]) => requestCancel(...a),
}))
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  cancelRendererBackgroundRun: (...a: unknown[]) => cancelBackground(...a),
}))
jest.mock("@/stores/agent/subagent-runtime-store", () => ({
  useSubagentRuntimeStore: { getState: () => ({ setStatus }) },
}))

import { cancelSubagentRun } from "./cancel-subagent"

beforeEach(() => {
  requestCancel.mockClear()
  cancelBackground.mockClear()
  setStatus.mockClear()
})

describe("cancelSubagentRun", () => {
  it("requests cancel and marks the node cancelled (foreground)", () => {
    expect(cancelSubagentRun("r1")).toBe(true)
    expect(requestCancel).toHaveBeenCalledWith("r1")
    expect(cancelBackground).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith("r1", "cancelled")
  })

  it("also cancels the background run when backgrounded", () => {
    cancelSubagentRun("r2", { backgrounded: true })
    expect(requestCancel).toHaveBeenCalledWith("r2")
    expect(cancelBackground).toHaveBeenCalledWith("r2")
    expect(setStatus).toHaveBeenCalledWith("r2", "cancelled")
  })
})
