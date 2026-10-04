const requestCancel = jest.fn((..._a: unknown[]) => true)
const cancelBackground = jest.fn((..._a: unknown[]) => true)
const setStatus = jest.fn()

jest.mock("./subagent-cancel-registry", () => ({
  requestCancelSubagentRunAndWait: (...a: unknown[]) => requestCancel(...a),
}))
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  hasRendererBackgroundRun: () => false,
  cancelRendererBackgroundRunAndWait: (...a: unknown[]) => cancelBackground(...a),
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
  it("requests cancel and marks the node cancelled (foreground)", async () => {
    expect(await cancelSubagentRun("r1")).toBe(true)
    expect(requestCancel).toHaveBeenCalledWith("r1", undefined)
    expect(cancelBackground).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith("r1", "cancelled")
  })

  it("uses the existing background control exactly once when backgrounded", async () => {
    await cancelSubagentRun("r2", { backgrounded: true })
    expect(requestCancel).not.toHaveBeenCalled()
    expect(cancelBackground).toHaveBeenCalledWith("r2")
    expect(setStatus).toHaveBeenCalledWith("r2", "cancelled")
  })
})

it("does not mark a run cancelled until the persistence receipt resolves", async () => {
  let resolve!: (value: boolean) => void
  cancelBackground.mockReturnValueOnce(
    new Promise<boolean>((done) => {
      resolve = done
    }) as never
  )
  const result = cancelSubagentRun("r3", { backgrounded: true })
  expect(setStatus).not.toHaveBeenCalled()
  resolve(false)
  await expect(result).resolves.toBe(false)
  expect(setStatus).not.toHaveBeenCalled()
})
