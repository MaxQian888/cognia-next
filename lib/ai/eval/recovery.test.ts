const mockRecoverInterrupted = jest.fn(async (..._args: unknown[]) => ({
  interruptedTaskIds: ["ambiguous"],
  requeuedTaskIds: [],
}))
const mockToArray = jest.fn(async () => [
  { id: "default-running", state: "running", updatedAt: 10 },
])
const mockFilter = jest.fn(() => ({ toArray: mockToArray }))

jest.mock("@/lib/db/eval-lab", () => ({
  recoverInterruptedEvalWork: (...args: unknown[]) => mockRecoverInterrupted(...args),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ evalExperiments: { filter: mockFilter } }),
}))

import { recoverEvalQueueOnStartup } from "./recovery"

describe("evaluation queue startup recovery", () => {
  beforeEach(() => {
    mockRecoverInterrupted.mockClear()
    mockToArray.mockClear()
    mockFilter.mockClear()
  })

  it("recovers running experiments and returns the latest resumable state", async () => {
    const recover = jest.fn(async (id: string) => ({
      interruptedTaskIds: id === "new" ? ["ambiguous"] : [],
      requeuedTaskIds: id === "old" ? ["safe"] : [],
    }))
    const result = await recoverEvalQueueOnStartup({
      listCandidates: async () => [
        { id: "old", state: "running", updatedAt: 1 },
        { id: "new", state: "running", updatedAt: 2 },
        { id: "paused", state: "paused", updatedAt: 3 },
      ],
      recover,
    })

    expect(recover).toHaveBeenCalledTimes(2)
    expect(result).toEqual([
      { experimentId: "paused", state: "paused" },
      { experimentId: "new", state: "interrupted" },
      { experimentId: "old", state: "queued" },
    ])
  })

  it("uses the persisted experiment query and recovery implementation by default", async () => {
    await expect(recoverEvalQueueOnStartup()).resolves.toEqual([
      { experimentId: "default-running", state: "interrupted" },
    ])
    expect(mockFilter).toHaveBeenCalled()
    expect(mockRecoverInterrupted).toHaveBeenCalledWith("default-running")
  })
})
