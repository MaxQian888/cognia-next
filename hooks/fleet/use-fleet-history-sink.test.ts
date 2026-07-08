/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from "@testing-library/react"

const streamState: {
  snapshot: { sessions: unknown[]; generatedAt: number }
  available: boolean
} = { snapshot: { sessions: [], generatedAt: 0 }, available: true }
jest.mock("./use-fleet-stream", () => ({
  useFleetStream: () => streamState,
}))

const recordMock = jest.fn()
jest.mock("@/lib/db/fleet-sessions", () => ({
  recordFleetHistory: (...args: unknown[]) => recordMock(...args),
  fleetHistoryId: (agent: string, sessionId: string) => `${agent}:${sessionId}`,
}))

import { toHistoryRow, useFleetHistorySink } from "./use-fleet-history-sink"
import type { FleetSession } from "@/lib/fleet/types"

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    status: "working",
    cwd: "/proj",
    projectName: "proj",
    lastPrompt: "do it",
    activity: null,
    permissionMode: null,
    model: null,
    terminal: { app: "ghostty", label: "Ghostty" },
    transcriptPath: "/t.jsonl",
    agentPid: 1,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: true,
      openTranscript: true,
    },
    startedAt: 1000,
    lastEventAt: 2000,
    ...overrides,
  }
}

beforeEach(() => {
  recordMock.mockReset()
  streamState.available = true
  streamState.snapshot = { sessions: [], generatedAt: 0 }
})

describe("toHistoryRow", () => {
  it("projects an active session", () => {
    const r = toHistoryRow(session(), 5000)
    expect(r).toMatchObject({
      id: "claude-code:s1",
      agent: "claude-code",
      firstPrompt: "do it",
      terminalLabel: "Ghostty",
      transcriptPath: "/t.jsonl",
      startedAt: 1000,
      updatedAt: 5000,
      endedAt: null,
      outcome: "active",
    })
  })

  it("marks an ended session with its end time", () => {
    const r = toHistoryRow(session({ status: "ended", endedAt: 4200 }), 5000)
    expect(r.outcome).toBe("ended")
    expect(r.endedAt).toBe(4200)
  })

  it("falls back to updatedAt when an ended session has no endedAt", () => {
    const r = toHistoryRow(session({ status: "ended" }), 5000)
    expect(r.endedAt).toBe(5000)
  })

  it("records a null terminal label when the source is unknown", () => {
    const r = toHistoryRow(session({ terminal: null }), 5000)
    expect(r.terminalLabel).toBeNull()
  })
})

describe("useFleetHistorySink", () => {
  it("persists every session in the snapshot", async () => {
    streamState.snapshot = {
      generatedAt: 5000,
      sessions: [session(), session({ sessionId: "s2" })],
    }
    renderHook(() => useFleetHistorySink())
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(2))
    expect(recordMock.mock.calls[0][0].updatedAt).toBe(5000)
  })

  it("does nothing off Tauri or with an empty snapshot", () => {
    streamState.available = false
    streamState.snapshot = { generatedAt: 1, sessions: [session()] }
    renderHook(() => useFleetHistorySink())
    expect(recordMock).not.toHaveBeenCalled()

    streamState.available = true
    streamState.snapshot = { generatedAt: 1, sessions: [] }
    renderHook(() => useFleetHistorySink())
    expect(recordMock).not.toHaveBeenCalled()
  })
})
