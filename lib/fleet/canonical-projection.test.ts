import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { createEnvelopeSequencer } from "@/lib/ai/agent/execution/event-envelope"

import type { FleetSession } from "./types"
import {
  CANONICAL_SESSION_LINGER_MS,
  canonicalSessionExpired,
  fleetCanonicalRunId,
  projectCanonicalFleetSession,
  projectFleetSessionEnvelopes,
  projectNameOf,
} from "./canonical-projection"

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
const envelope = createEnvelopeSequencer({
  sessionId: "s1",
  runId: "r1",
  attemptId: "a1",
  parentRunId: "parent",
  hostRef: "desktop",
  runtime: "claude-agent-sdk",
  turnId: "t1",
})

describe("projectCanonicalFleetSession", () => {
  it("projects canonical native lifecycle and tool activity for Team children", () => {
    let session = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "lifecycle", phase: "started" }),
      100
    )
    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "tool-call", toolName: "Read", input: {} }),
      200
    )
    expect(session).toMatchObject({
      agent: "cognia",
      origin: "team",
      lifecycleConfidence: "native",
      status: "working",
      activity: { toolName: "Read" },
      toolUseCount: 1,
    })
  })

  it("ends a canonical session without exposing unproven external controls", () => {
    const session = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "lifecycle", phase: "ended" }),
      300
    )
    expect(session.status).toBe("ended")
    expect(session.endedAt).toBe(300)
    expect(session.capabilities.focusTerminal).toBe(false)
  })

  it("declares no interrupt capability for a Cognia run, which has no pid to signal", () => {
    const session = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "lifecycle", phase: "started" }),
      100
    )
    expect(session.capabilities.interrupt).toBe(false)
    expect(session.capabilities.approvePermission).toBe(false)
  })

  it("keeps the canonical lineage that routes the row to its owning page", () => {
    const session = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "lifecycle", phase: "started" }),
      100
    )
    expect(session.sessionId).toBe("s1")
    expect(session.executionRunId).toBe("r1")
    expect(session.agentTeamRunId).toBe("parent")
    expect(session.origin).toBe("team")
  })

  it("treats an interrupted lifecycle as terminal rather than resuming work", () => {
    let session = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "lifecycle", phase: "started" }),
      100
    )
    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "lifecycle", phase: "interrupted", detail: "user cancelled" }),
      200
    )
    expect(session.status).toBe("ended")
    expect(session.endedAt).toBe(200)
    expect(session.lastError?.detail).toBe("user cancelled")
  })

  it("holds a permission until its OWN resolution arrives", () => {
    let session = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "permission-request", requestId: "p1", toolName: "Bash" }),
      100
    )
    expect(session.status).toBe("waiting-permission")

    // Unrelated traffic must not release a prompt the user has not answered.
    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "session-state", state: "running" }),
      110
    )
    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "activity", phase: "requesting", detail: "thinking" }),
      120
    )
    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "permission-resolved", requestId: "other", behavior: "allow" }),
      130
    )
    expect(session.status).toBe("waiting-permission")
    expect(session.pendingPermission?.requestId).toBe("p1")

    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "permission-resolved", requestId: "p1", behavior: "allow" }),
      140
    )
    expect(session.pendingPermission).toBeNull()
    expect(session.status).toBe("working")
  })

  it("parks an elicitation as an answerable question and clears it on its resolution", () => {
    let session = projectCanonicalFleetSession(
      undefined,
      envelope({
        kind: "elicitation-request",
        requestId: "q1",
        source: "ask_user",
        prompt: "Which one?",
        schema: { type: "array", enum: ["a", "b"] },
      }),
      100
    )
    expect(session.status).toBe("waiting-input")
    expect(session.pendingQuestionRequest?.requestId).toBe("q1")
    expect(session.pendingQuestions?.[0]).toMatchObject({
      question: "Which one?",
      options: ["a", "b"],
      multiSelect: true,
    })

    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "elicitation-resolved", requestId: "q1", outcome: "answered" }),
      200
    )
    expect(session.pendingQuestionRequest).toBeNull()
    expect(session.pendingQuestions).toBeUndefined()
    expect(session.status).toBe("working")
  })

  it("records session-init bindings and counts a turn per user input", () => {
    let session = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "session-init", model: "claude-opus-5", permissionMode: "plan", cwd: "/w" }),
      100
    )
    expect(session).toMatchObject({
      model: "claude-opus-5",
      permissionMode: "plan",
      cwd: "/w",
      // Derived from the cwd, as the Rust registry does for external agents,
      // so the island and the fleet list never fall back to the session UUID.
      projectName: "w",
    })

    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "user-input", text: "go" }),
      200
    )
    expect(session.turnCount).toBe(1)
    expect(session.lastPrompt).toBe("go")
  })

  it("clears activity on a tool result and records a failed one as an error", () => {
    let session = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "tool-call", toolName: "Bash", input: {} }),
      100
    )
    expect(session.activity).toEqual({ toolName: "Bash", detail: null })

    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "tool-result", toolName: "Bash", result: null, isError: true }),
      200
    )
    expect(session.activity).toBeNull()
    expect(session.lastError).toMatchObject({ kind: "tool", detail: "Bash" })
  })

  it("goes idle on an idle activity and back to working on a running state", () => {
    let session = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "activity", phase: "idle" }),
      100
    )
    expect(session.status).toBe("idle")
    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "session-state", state: "running" }),
      200
    )
    expect(session.status).toBe("working")
    session = projectCanonicalFleetSession(
      session,
      envelope({ kind: "session-state", state: "requires-action" }),
      300
    )
    expect(session.status).toBe("waiting-input")
  })

  it("records a failure without pretending the session ended", () => {
    const session = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "failure", code: "boom", message: "it broke" }),
      100
    )
    expect(session.lastError).toMatchObject({ kind: "turn", detail: "it broke" })
    expect(session.status).toBe("working")
  })
})

describe("canonicalSessionExpired", () => {
  it("keeps a finished session for the linger window, then lets it go", () => {
    const ended = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "lifecycle", phase: "ended" }),
      1_000
    )
    expect(canonicalSessionExpired(ended, 1_000 + CANONICAL_SESSION_LINGER_MS)).toBe(false)
    expect(canonicalSessionExpired(ended, 1_000 + CANONICAL_SESSION_LINGER_MS + 1)).toBe(true)
  })

  it("never expires a live session", () => {
    const live = projectCanonicalFleetSession(
      undefined,
      envelope({ kind: "lifecycle", phase: "started" }),
      1_000
    )
    expect(canonicalSessionExpired(live, 1_000 + CANONICAL_SESSION_LINGER_MS * 10)).toBe(false)
  })
})

describe("projectNameOf", () => {
  it("takes the last path segment on either separator and tolerates junk", () => {
    expect(projectNameOf("/Users/me/cognia-next")).toBe("cognia-next")
    expect(projectNameOf("/Users/me/cognia-next/")).toBe("cognia-next")
    expect(projectNameOf("C:\\work\\repo")).toBe("repo")
    expect(projectNameOf("/")).toBeNull()
    expect(projectNameOf("")).toBeNull()
    expect(projectNameOf(null)).toBeNull()
  })
})
