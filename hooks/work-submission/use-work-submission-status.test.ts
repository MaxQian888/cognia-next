/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { WorkSubmissionRow } from "@/lib/db/work-submissions"

import { useWorkSubmissionStatus, workSubmissionUiState } from "./use-work-submission-status"

const NOW = 1_755_000_000_000

function row(overrides: Partial<WorkSubmissionRow> = {}): WorkSubmissionRow {
  return {
    id: "submission-1",
    accountId: "account-1",
    idempotencyKey: "key-1",
    runId: "run-1",
    turnId: "turn-1",
    sessionId: "session-1",
    runtimeTargetId: "target-1",
    sourceKind: "chat",
    sourceId: "session-1",
    availabilityPolicy: "wait",
    dispatchState: "pending",
    nextAttemptAt: NOW,
    attemptCount: 0,
    inputBatchId: "batch-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe("workSubmissionUiState", () => {
  it("is idle with no submission", () => {
    expect(workSubmissionUiState(undefined)).toEqual({ state: "idle" })
  })

  it.each(["pending", "claimed"] as const)("maps %s onto queued", (dispatchState) => {
    expect(workSubmissionUiState(row({ dispatchState })).state).toBe("queued")
  })

  it("maps blocked onto blocked", () => {
    expect(workSubmissionUiState(row({ dispatchState: "blocked" })).state).toBe("blocked")
  })

  it("treats dispatched as idle, because the streaming UI already says so", () => {
    // A second indicator alongside a live stream is noise, not information.
    expect(workSubmissionUiState(row({ dispatchState: "dispatched" })).state).toBe("idle")
  })

  it.each(["completed", "no_response", "failed", "cancelled"] as const)(
    "treats a %s settle as idle",
    (terminalOutcome) => {
      expect(workSubmissionUiState(row({ dispatchState: "settled", terminalOutcome })).state).toBe(
        "idle"
      )
    }
  )

  it("surfaces a recovery_required settle, because only a person can clear it", () => {
    const status = workSubmissionUiState(
      row({ dispatchState: "settled", terminalOutcome: "recovery_required" })
    )
    expect(status.state).toBe("recoveryRequired")
    expect(status.submission?.id).toBe("submission-1")
  })

  it("carries the submission on every non-idle state", () => {
    expect(workSubmissionUiState(row({ dispatchState: "blocked" })).submission?.id).toBe(
      "submission-1"
    )
  })
})

describe("useWorkSubmissionStatus", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  }, 30_000)

  it("is idle for a session with no submissions", async () => {
    const { result } = renderHook(() => useWorkSubmissionStatus("session-1"))
    await waitFor(() => expect(result.current.state).toBe("idle"))
  }, 30_000)

  it("is idle when no session id is given", async () => {
    const { result } = renderHook(() => useWorkSubmissionStatus(undefined))
    await waitFor(() => expect(result.current.state).toBe("idle"))
  }, 30_000)

  it("reports a blocked submission for the session", async () => {
    await getDb().workSubmissions.add(row({ dispatchState: "blocked" }))
    const { result } = renderHook(() => useWorkSubmissionStatus("session-1"))
    await waitFor(() => expect(result.current.state).toBe("blocked"))
  }, 30_000)

  it("ignores submissions belonging to another session", async () => {
    await getDb().workSubmissions.add(row({ dispatchState: "blocked", sessionId: "session-2" }))
    const { result } = renderHook(() => useWorkSubmissionStatus("session-1"))
    await waitFor(() => expect(result.current.state).toBe("idle"))
  }, 30_000)

  it("reflects the newest submission when a session has several", async () => {
    await getDb().workSubmissions.bulkAdd([
      row({ dispatchState: "settled", terminalOutcome: "completed" }),
      row({
        id: "submission-2",
        idempotencyKey: "key-2",
        runId: "run-2",
        dispatchState: "blocked",
        createdAt: NOW + 10,
      }),
    ])
    const { result } = renderHook(() => useWorkSubmissionStatus("session-1"))
    await waitFor(() => expect(result.current.state).toBe("blocked"))
  }, 30_000)
})
