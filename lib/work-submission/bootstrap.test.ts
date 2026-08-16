/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getAgentExecutionFlags } from "@/lib/ai/agent/execution/feature-flags"

import { startHeadlessWorkOutbox, startRendererWorkOutbox } from "./bootstrap"

const stopTerminalEvents = jest.fn()

jest.mock("./terminal-events", () => ({
  startWorkSubmissionTerminalEvents: jest.fn(({ onReady }: { onReady?: () => void } = {}) => {
    onReady?.()
    return stopTerminalEvents
  }),
}))

jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  getAgentExecutionFlags: jest.fn(() => ({ durableWorkSubmission: false })),
}))

const flags = getAgentExecutionFlags as jest.MockedFunction<typeof getAgentExecutionFlags>

function enable(enabled: boolean) {
  flags.mockReturnValue({ durableWorkSubmission: enabled } as ReturnType<
    typeof getAgentExecutionFlags
  >)
}

describe("work outbox bootstrap", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    jest.useFakeTimers()
    enable(false)
    stopTerminalEvents.mockClear()
  }, 30_000)

  afterEach(() => {
    jest.useRealTimers()
  })

  it.each([
    ["renderer", startRendererWorkOutbox],
    ["headless", startHeadlessWorkOutbox],
  ])("%s start is a no-op while the feature is off", (_label, start) => {
    const listClaimable = jest.fn(async () => [])
    const stop = start({ listClaimable })
    expect(listClaimable).not.toHaveBeenCalled()
    // Still returns a callable teardown so a React effect cleanup is safe.
    expect(() => stop()).not.toThrow()
  })

  it.each([
    ["renderer", startRendererWorkOutbox],
    ["headless", startHeadlessWorkOutbox],
  ])("%s sweeps immediately once the feature is on", (_label, start) => {
    enable(true)
    const listClaimable = jest.fn(async () => [])
    const stop = start({ listClaimable })
    expect(listClaimable).toHaveBeenCalledTimes(1)
    stop()
  })

  it("stops sweeping after teardown", () => {
    enable(true)
    const listClaimable = jest.fn(async () => [])
    const stop = startRendererWorkOutbox({ listClaimable })
    stop()
    jest.advanceTimersByTime(10 * 60_000)
    expect(listClaimable).toHaveBeenCalledTimes(1)
    expect(stopTerminalEvents).toHaveBeenCalledTimes(1)
  })

  it("logs a sweep failure through the default error reporter", async () => {
    // Without an injected reporter a failing sweep must still surface; a silent
    // recovery loop is indistinguishable from a working one.
    enable(true)
    jest.useRealTimers()
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const stop = startRendererWorkOutbox({
        listClaimable: async () => {
          throw new Error("index unavailable")
        },
      })
      for (let attempt = 0; attempt < 50 && consoleError.mock.calls.length === 0; attempt += 1) {
        await new Promise((settle) => setTimeout(settle, 20))
      }
      stop()
      expect(consoleError).toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  }, 30_000)

  it("parks a legacy row that lacks the frozen payload needed by production dispatch", async () => {
    enable(true)
    jest.useRealTimers()

    const row = {
      id: "submission-1",
      accountId: "account-1",
      idempotencyKey: "key-1",
      runId: "run-1",
      turnId: "turn-1",
      sessionId: "session-1",
      runtimeTargetId: "target-1",
      sourceKind: "chat" as const,
      sourceId: "session-1",
      availabilityPolicy: "wait" as const,
      dispatchState: "pending" as const,
      nextAttemptAt: 1,
      attemptCount: 0,
      inputBatchId: "batch-1",
      createdAt: 1,
      updatedAt: 1,
    }
    await getDb().workSubmissions.add(row)

    const stop = startRendererWorkOutbox({
      listClaimable: async () => [row],
      onError: () => {},
    })
    // The immediate sweep is fire-and-forget; poll until it has landed.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await getDb().workSubmissions.get("submission-1")
      if (current?.dispatchState === "settled") break
      await new Promise((settle) => setTimeout(settle, 20))
    }
    stop()

    const stored = await getDb().workSubmissions.get("submission-1")
    expect(stored).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "recovery_required",
      errorCode: "missing_frozen_input",
    })
  }, 30_000)
})
