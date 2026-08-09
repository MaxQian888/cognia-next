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

const reconcileMock = jest.fn()
const pruneMock = jest.fn()
jest.mock("@/lib/db/fleet-sessions", () => ({
  reconcileFleetHistory: (...args: unknown[]) => reconcileMock(...args),
  fleetHistoryId: (agent: string, sessionId: string) => `${agent}:${sessionId}`,
}))

const appendMock = jest.fn()
jest.mock("@/lib/ai/agent/recovery/canonical-log", () => ({
  appendCanonicalEnvelopes: (...args: unknown[]) => appendMock(...args),
  pruneCanonicalEnvelopeDetails: () => pruneMock(),
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
      interrupt: false,
    },
    startedAt: 1000,
    lastEventAt: 2000,
    toolUseCount: 0,
    turnCount: 0,
    ...overrides,
  }
}

beforeEach(() => {
  reconcileMock.mockReset().mockResolvedValue(undefined)
  appendMock.mockReset().mockResolvedValue(1)
  pruneMock.mockReset()
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
      canonicalRunId: expect.stringMatching(/^fleet:claude-code:[a-f0-9]{16}$/),
      toolUseCount: 0,
      turnCount: 0,
      lastErrorKind: null,
      lastErrorDetail: null,
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

  it("redacts prompts and errors before writing summary history", () => {
    const r = toHistoryRow(
      session({
        lastPrompt: "contact alice@example.com",
        lastError: { kind: "turn", detail: "token sk-proj-abcdefghijklmnop", at: 4_000 },
      }),
      5_000
    )
    expect(r.firstPrompt).toBe("contact <EMAIL_001>")
    expect(r.lastErrorDetail).toBe("token <API_KEY_001>")
  })
})

describe("useFleetHistorySink", () => {
  it("prunes expired canonical detail when the desktop sink mounts", async () => {
    renderHook(() => useFleetHistorySink())
    await waitFor(() => expect(pruneMock).toHaveBeenCalledTimes(1))
  })
  it("persists every session in the snapshot", async () => {
    streamState.snapshot = {
      generatedAt: 5000,
      sessions: [session(), session({ sessionId: "s2" })],
    }
    renderHook(() => useFleetHistorySink())
    await waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(1))
    expect(reconcileMock.mock.calls[0][0]).toHaveLength(2)
    expect(reconcileMock.mock.calls[0][0][0].updatedAt).toBe(5000)
    expect(appendMock).toHaveBeenCalledTimes(2)
    expect(appendMock.mock.calls[0][0]).toMatch(/^fleet:claude-code:[a-f0-9]{16}$/)
  })

  it("does not append unchanged canonical facts on rerender", async () => {
    const live = session()
    streamState.snapshot = { generatedAt: 5000, sessions: [live] }
    const { rerender } = renderHook(() => useFleetHistorySink())
    await waitFor(() => expect(appendMock).toHaveBeenCalledTimes(1))

    streamState.snapshot = { generatedAt: 6000, sessions: [live] }
    rerender()
    await waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(2))
    expect(appendMock).toHaveBeenCalledTimes(1)
  })

  it("does nothing off Tauri and reconciles an empty authoritative snapshot", () => {
    streamState.available = false
    streamState.snapshot = { generatedAt: 1, sessions: [session()] }
    renderHook(() => useFleetHistorySink())
    expect(reconcileMock).not.toHaveBeenCalled()

    streamState.available = true
    streamState.snapshot = { generatedAt: 1, sessions: [] }
    const { rerender } = renderHook(() => useFleetHistorySink())
    rerender()
    expect(reconcileMock).toHaveBeenCalledWith([], 1)
  })
})
