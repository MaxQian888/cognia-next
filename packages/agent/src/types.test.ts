import type {
  AgentTurnOutcome,
  ClientToolRegistration,
  CompactionResult,
  SessionState,
} from "./types"

describe("public SDK types", () => {
  it("models compaction as a command with an optional live undo boundary", () => {
    const compacted: CompactionResult = {
      accepted: true,
      commandId: "compact-one",
      undoAvailable: false,
    }
    expect(compacted.boundaryId).toBeUndefined()
  })

  it("have serializable representative shapes", () => {
    const registration: ClientToolRegistration = {
      handlerId: "handler-1",
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" },
      sideEffect: "none",
    }
    const outcome: AgentTurnOutcome = {
      status: "requires_action",
      suspended: { sessionId: "s", runId: "r", turnId: "t" },
    }
    const state: SessionState = { sessionId: "s", status: "idle" }

    expect(JSON.parse(JSON.stringify({ registration, outcome, state }))).toMatchObject({
      outcome: { status: "requires_action" },
      state: { status: "idle" },
    })
  })
})
