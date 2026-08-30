const mockEnqueue = jest.fn()
const mockDrain = jest.fn()
const mockGetState = jest.fn()

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => mockGetState() },
}))
jest.mock("@/lib/memory/lifecycle/enqueue-turn-memory", () => ({
  enqueueTurnMemory: (...a: unknown[]) => mockEnqueue(...a),
}))
jest.mock("@/lib/memory/lifecycle/job-worker", () => ({
  drainMemoryJobsAfterTurn: (...a: unknown[]) => mockDrain(...a),
}))

import { runTurnMemory } from "./run-turn-memory"

const INPUT = {
  userText: "remember my timezone is UTC+8",
  assistantText: "noted, UTC+8",
  transcript: [{ role: "user", text: "remember my timezone is UTC+8" }],
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetState.mockReturnValue({ settings: { memory: {} } })
  mockEnqueue.mockResolvedValue({ enqueued: true, jobId: "job-1" })
  mockDrain.mockResolvedValue(1)
})

describe("runTurnMemory", () => {
  it("hands the renderer's settings to the host-neutral enqueue", async () => {
    await runTurnMemory("s1", INPUT)
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", settings: { memory: {} } })
    )
  })

  it("lets the enqueue read Dexie when the store is not hydrated", async () => {
    mockGetState.mockReturnValue({ settings: null })
    await runTurnMemory("s1", INPUT)
    expect(mockEnqueue).toHaveBeenCalledWith(expect.not.objectContaining({ settings: null }))
  })

  it("asks for one job right away so the turn's result is not interval-delayed", async () => {
    await runTurnMemory("s1", INPUT)
    expect(mockDrain).toHaveBeenCalledTimes(1)
  })

  it("does not drain when nothing was queued", async () => {
    mockEnqueue.mockResolvedValue({ enqueued: false, reason: "disabled" })
    await runTurnMemory("s1", INPUT)
    expect(mockDrain).not.toHaveBeenCalled()
  })

  it("never breaks a send", async () => {
    mockEnqueue.mockRejectedValue(new Error("boom"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await expect(runTurnMemory("s1", INPUT)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
