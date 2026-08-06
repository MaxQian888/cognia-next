import { createEnvelopeSequencer } from "@/lib/ai/agent/execution/event-envelope"
import { projectCanonicalFleetSession } from "./canonical-projection"

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
})
