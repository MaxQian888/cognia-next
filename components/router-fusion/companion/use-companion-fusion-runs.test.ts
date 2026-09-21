/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

const mockEnqueue = jest.fn()
jest.mock("@/lib/router-fusion/api/companion-run-client", () => ({
  enqueueCompanionFusionRun: (...args: unknown[]) => mockEnqueue(...args),
}))

let mockHost: unknown = undefined
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({ host: mockHost }),
}))

import { companionFusionAvailable, useCompanionFusionRuns } from "./use-companion-fusion-runs"

const READY = {
  compatible: true,
  operations: ["execution_run_create", "execution_run_get", "execution_run_events"],
  grants: ["host.observe", "agent.run"],
}

beforeEach(() => {
  mockHost = undefined
  mockEnqueue.mockReset()
})

describe("companionFusionAvailable", () => {
  it("is the host's answer: healthy operations and the device's grant", () => {
    expect(companionFusionAvailable(READY)).toBe(true)
    expect(companionFusionAvailable(undefined)).toBe(false)
    expect(companionFusionAvailable({ ...READY, compatible: false })).toBe(false)
    // The host reports the operation unhealthy while its companion switch is off.
    expect(
      companionFusionAvailable({
        ...READY,
        operations: ["execution_run_get", "execution_run_events"],
      })
    ).toBe(false)
    // A device without the Control grant's agent.run is never offered a run.
    expect(companionFusionAvailable({ ...READY, grants: ["host.observe"] })).toBe(false)
  })
})

describe("useCompanionFusionRuns", () => {
  it("queues a run for its conversation and lists it there only", async () => {
    mockHost = READY
    mockEnqueue.mockImplementation(async (input: { sessionId: string }) => ({
      rowId: `row-${input.sessionId}`,
      idempotencyKey: "k",
      payload: {},
      mode: "cascade",
      sessionId: input.sessionId,
      createdAt: 1,
    }))
    const { result, rerender } = renderHook(({ id }) => useCompanionFusionRuns(id), {
      initialProps: { id: "s1" },
    })
    expect(result.current.available).toBe(true)
    await act(async () => {
      await result.current.start("summarise", "cascade", "Cascade run")
    })
    expect(mockEnqueue).toHaveBeenCalledWith({
      sessionId: "s1",
      text: "summarise",
      mode: "cascade",
      label: "Cascade run",
    })
    expect(result.current.runs.map((run) => run.rowId)).toEqual(["row-s1"])

    rerender({ id: "s2" })
    expect(result.current.runs).toEqual([])
    rerender({ id: "s1" })
    expect(result.current.runs).toHaveLength(1)

    act(() => result.current.dismiss("row-s1"))
    expect(result.current.runs).toEqual([])
  })

  it("is unavailable, and loads nothing, when the host does not offer runs", () => {
    const { result } = renderHook(() => useCompanionFusionRuns("s1"))
    expect(result.current.available).toBe(false)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})
