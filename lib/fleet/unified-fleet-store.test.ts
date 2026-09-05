/** @jest-environment jsdom */
import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

const subscribeAgentEventsMock = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  subscribeAgentEvents: (...a: unknown[]) => subscribeAgentEventsMock(...a),
}))
jest.mock("@/lib/ai/agent/recovery/canonical-log", () => ({
  appendCanonicalEnvelopes: jest.fn(async () => {}),
}))
jest.mock("@/lib/ai/agent/execution/event-envelope", () => ({
  redactAgentEventEnvelope: (envelope: unknown) => envelope,
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("./fleet-stream-store", () => ({
  EMPTY_FLEET_SNAPSHOT: { sessions: [], generatedAt: 0 },
  fleetStreamStore: {
    subscribe: () => () => {},
    getSnapshot: () => ({ sessions: [], generatedAt: 0 }),
  },
}))

import type { FleetSession } from "./types"
import { mergeFleetSnapshots, unifiedFleetStore } from "./unified-fleet-store"
import { CANONICAL_SESSION_LINGER_MS } from "./canonical-projection"

function session(agent: FleetSession["agent"], sessionId: string): FleetSession {
  return {
    agent,
    sessionId,
    status: "working",
    cwd: null,
    projectName: null,
    lastPrompt: null,
    activity: null,
    permissionMode: null,
    model: null,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
      interrupt: false,
    },
    startedAt: 1,
    lastEventAt: 2,
    toolUseCount: 0,
    turnCount: 0,
  }
}

describe("mergeFleetSnapshots", () => {
  it("combines external and canonical executions and labels legacy rows", () => {
    const canonical = new Map([["built-in", session("cognia", "built-in")]])
    const merged = mergeFleetSnapshots(
      { sessions: [session("codex", "external")], generatedAt: 10 },
      canonical,
      20
    )
    expect(merged.sessions.map(({ agent, origin }) => [agent, origin])).toEqual([
      ["codex", "external"],
      ["cognia", undefined],
    ])
    expect(merged.generatedAt).toBe(20)
  })
})

describe("canonical result state", () => {
  let emit: (envelope: AgentEventEnvelope) => void = () => {}

  function envelope(event: Record<string, unknown>, sessionId = "cognia-1"): AgentEventEnvelope {
    return {
      schemaVersion: 1,
      eventId: `${sessionId}:${Math.random()}`,
      sequence: 1,
      sessionId,
      runId: "run-1",
      turnId: "t1",
      attemptId: "a1",
      hostRef: "local-desktop",
      runtime: "claude-agent-sdk",
      timestamp: new Date(0).toISOString(),
      event,
    } as AgentEventEnvelope
  }

  beforeEach(() => {
    jest.useFakeTimers()
    unifiedFleetStore.resetForTests?.()
    subscribeAgentEventsMock.mockReset().mockImplementation(async (handler: typeof emit) => {
      emit = handler
      return () => {}
    })
  })
  afterEach(() => {
    unifiedFleetStore.resetForTests?.()
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  async function attach() {
    const off = unifiedFleetStore.subscribe(() => {})
    await Promise.resolve()
    return off
  }

  it("keeps a finished session for the linger window, then sweeps it", async () => {
    const off = await attach()
    emit(envelope({ kind: "lifecycle", phase: "started" }))
    expect(unifiedFleetStore.getSnapshot().sessions).toHaveLength(1)

    emit(envelope({ kind: "lifecycle", phase: "ended" }))
    jest.advanceTimersByTime(CANONICAL_SESSION_LINGER_MS - 1)
    expect(unifiedFleetStore.getSnapshot().sessions).toHaveLength(1)

    jest.advanceTimersByTime(1_000)
    expect(unifiedFleetStore.getSnapshot().sessions).toHaveLength(0)
    off()
  })

  it("cancels the sweep when the same session starts again", async () => {
    const off = await attach()
    emit(envelope({ kind: "lifecycle", phase: "ended" }))
    jest.advanceTimersByTime(CANONICAL_SESSION_LINGER_MS / 2)
    emit(envelope({ kind: "lifecycle", phase: "started" }))

    jest.advanceTimersByTime(CANONICAL_SESSION_LINGER_MS * 2)
    const sessions = unifiedFleetStore.getSnapshot().sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0].status).toBe("working")
    off()
  })

  it("evicts an expired row on resubscribe, when no timer survived the detach", async () => {
    const off = await attach()
    emit(envelope({ kind: "lifecycle", phase: "ended" }))
    off()

    // The detach cleared the sweep timer. Time passes with nobody listening.
    jest.advanceTimersByTime(CANONICAL_SESSION_LINGER_MS * 3)
    const again = await attach()
    expect(unifiedFleetStore.getSnapshot().sessions).toHaveLength(0)
    again()
  })
})
