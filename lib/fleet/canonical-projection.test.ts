import { hasNoLeakingPiiDeep } from "@cognia/redact"

import type { FleetSession } from "./types"
import { fleetCanonicalRunId, projectFleetSessionEnvelopes } from "./canonical-projection"

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "opencode",
    sessionId: "session-1",
    status: "working",
    cwd: "/workspace",
    projectName: "workspace",
    lastPrompt: "implement it",
    activity: null,
    permissionMode: "default",
    model: "model",
    terminal: { app: "ghostty", label: "Ghostty" },
    transcriptPath: null,
    agentPid: 123,
    pendingPermission: null,
    capabilities: {
      approvePermission: true,
      sendMessage: true,
      focusTerminal: true,
      openTranscript: false,
      interrupt: true,
    },
    startedAt: 1_000,
    lastEventAt: 2_000,
    toolUseCount: 0,
    turnCount: 1,
    ...overrides,
  }
}

describe("projectFleetSessionEnvelopes", () => {
  it("creates a stable canonical identity and initial lifecycle", () => {
    const current = session()
    const envelopes = projectFleetSessionEnvelopes(undefined, current)

    expect(fleetCanonicalRunId(current)).toMatch(/^fleet:opencode:[a-f0-9]{16}$/)
    expect(envelopes.map((envelope) => envelope.event.kind)).toEqual([
      "lifecycle",
      "session-init",
      "user-input",
      "activity",
      "session-state",
    ])
    expect(new Set(envelopes.map((envelope) => envelope.eventId)).size).toBe(envelopes.length)
    expect(envelopes.every((envelope) => envelope.runId === fleetCanonicalRunId(current))).toBe(
      true
    )
  })

  it("emits only changed activity, permission, subagent, and failure facts", () => {
    const previous = session()
    const current = session({
      activity: { toolName: "Bash", detail: "echo ok" },
      pendingPermission: {
        requestId: "permission-1",
        toolName: "Bash",
        detail: "run command",
        requestedAt: 2_100,
      },
      subagents: [
        { description: "research", agentType: "Explore", background: false, startedAt: 2_200 },
      ],
      lastError: { kind: "tool", detail: "failed", at: 2_300 },
      toolUseCount: 1,
      lastEventAt: 2_300,
    })

    expect(projectFleetSessionEnvelopes(previous, current).map((item) => item.event.kind)).toEqual([
      "tool-call",
      "permission-request",
      "subagent",
      "failure",
      "activity",
      "session-state",
    ])
    expect(projectFleetSessionEnvelopes(current, current)).toEqual([])
  })

  it("redacts persisted prompt and detail fields", () => {
    const envelopes = projectFleetSessionEnvelopes(
      undefined,
      session({
        lastPrompt: "email alice@example.com token sk-proj-abcdefghijklmnop",
        activity: { toolName: "Bash", detail: "contact bob@example.com" },
        toolUseCount: 1,
      })
    )

    expect(hasNoLeakingPiiDeep(envelopes)).toBe(true)
    expect(JSON.stringify(envelopes)).toContain("<EMAIL_001>")
  })

  it("emits a terminal lifecycle event exactly once", () => {
    const previous = session()
    const ended = session({ status: "ended", endedAt: 3_000, lastEventAt: 3_000 })

    const events = projectFleetSessionEnvelopes(previous, ended)
    expect(events.filter((item) => item.event.kind === "lifecycle")).toHaveLength(1)
    expect(events.find((item) => item.event.kind === "lifecycle")?.event).toEqual({
      kind: "lifecycle",
      phase: "ended",
    })
    expect(projectFleetSessionEnvelopes(ended, ended)).toEqual([])
  })

  it("projects native questions and subagent completion without raw secrets", () => {
    const previous = session({
      subagents: [
        { description: "research", agentType: "Explore", background: false, startedAt: 2_200 },
      ],
    })
    const current = session({
      status: "waiting-input",
      pendingQuestionRequest: { requestId: "question-1", requestedAt: 2_500 },
      pendingQuestions: [
        {
          question: "Email alice@example.com?",
          options: ["Send to bob@example.com", "Cancel"],
          multiSelect: false,
        },
      ],
      subagents: [],
      lastEventAt: 2_500,
    })

    const envelopes = projectFleetSessionEnvelopes(previous, current)
    expect(envelopes.map((item) => item.event.kind)).toContain("elicitation-request")
    expect(envelopes).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ kind: "subagent", phase: "ended" }),
      })
    )
    expect(envelopes).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ kind: "session-state", state: "requires-action" }),
      })
    )
    expect(hasNoLeakingPiiDeep(envelopes)).toBe(true)
  })
})
