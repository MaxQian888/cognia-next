import {
  AGENT_ERROR_CODES,
  AGENT_EXIT_CODES,
  exitCodeForError,
  isAgentRunResult,
  validateAgentRunResult,
  type AgentRunResultV1,
  type AgentStructuredError,
} from "./agent-run-result"

function result(overrides: Partial<AgentRunResultV1> = {}): AgentRunResultV1 {
  return {
    schemaVersion: 1,
    type: "result",
    status: "completed",
    sessionId: "s1",
    runId: "r1",
    turnId: "t1",
    attemptId: "a1",
    text: "hello",
    backend: "builtin",
    model: "claude-opus-5",
    capabilities: ["streaming", "session.multi-turn"],
    session: { persisted: true, sessionDir: "/home/u/.cognia/sessions/s1" },
    ...overrides,
  }
}

describe("validateAgentRunResult", () => {
  it("accepts a complete successful result", () => {
    expect(validateAgentRunResult(result())).toEqual([])
    expect(isAgentRunResult(result())).toBe(true)
  })

  it("rejects a non-object and a wrong schema version", () => {
    expect(validateAgentRunResult(null)).toEqual(["run result must be an object"])
    expect(validateAgentRunResult(result({ schemaVersion: 2 as 1 }))).toContain(
      "schemaVersion must be 1"
    )
  })

  it("requires every identity field", () => {
    for (const key of ["sessionId", "runId", "turnId", "attemptId", "backend", "model"] as const) {
      expect(validateAgentRunResult(result({ [key]: "" }))).toContain(
        `${key} must be a non-empty string`
      )
    }
  })

  it("rejects an unknown status and a non-string text", () => {
    expect(validateAgentRunResult(result({ status: "done" as "completed" }))).toContain(
      "status must be one of completed|failed|cancelled|timeout"
    )
    expect(validateAgentRunResult({ ...result(), text: 5 })).toContain("text must be a string")
  })

  it("requires sessionDir when persisted, and allows an unpersisted run", () => {
    expect(validateAgentRunResult(result({ session: { persisted: true } }))).toContain(
      "session.sessionDir is required when persisted"
    )
    expect(validateAgentRunResult(result({ session: { persisted: false } }))).toEqual([])
  })

  it("pairs status and error: failed needs one, completed forbids one", () => {
    expect(validateAgentRunResult(result({ status: "failed" }))).toContain(
      "error is required when status is not completed"
    )
    expect(
      validateAgentRunResult(result({ error: { code: "provider_error", message: "boom" } }))
    ).toContain("error must be absent when status is completed")
    expect(
      validateAgentRunResult(
        result({ status: "failed", error: { code: "provider_error", message: "boom" } })
      )
    ).toEqual([])
  })

  it("rejects an unknown error code and an empty message", () => {
    const bad = result({
      status: "failed",
      error: { code: "kaboom" as AgentStructuredError["code"], message: "x" },
    })
    expect(validateAgentRunResult(bad)).toContain("error.code must be a known agent error code")
    expect(
      validateAgentRunResult(result({ status: "failed", error: { code: "timeout", message: "" } }))
    ).toContain("error.message must be a non-empty string")
  })

  it("validates a resume report's fidelity and loss shape", () => {
    const ok = result({
      resume: {
        native: false,
        fidelity: "contextual",
        loss: { fidelity: "contextual", losses: [] },
      },
    })
    expect(validateAgentRunResult(ok)).toEqual([])
    const bad = result({
      resume: {
        native: false,
        fidelity: "perfect" as "contextual",
        loss: { fidelity: "contextual", losses: [] },
      },
    })
    expect(validateAgentRunResult(bad)).toContain("resume.fidelity must be a known fidelity level")
  })

  it("rejects a non-array capabilities field", () => {
    expect(validateAgentRunResult({ ...result(), capabilities: "streaming" })).toContain(
      "capabilities must be an array"
    )
  })
})

describe("exitCodeForError", () => {
  it("maps no error to success", () => {
    expect(exitCodeForError(undefined)).toBe(AGENT_EXIT_CODES.success)
  })

  it.each([
    ["usage_error", AGENT_EXIT_CODES.usage],
    ["config_error", AGENT_EXIT_CODES.usage],
    ["protocol_error", AGENT_EXIT_CODES.usage],
    ["permission_denied", AGENT_EXIT_CODES.denied],
    ["resource_untrusted", AGENT_EXIT_CODES.denied],
    ["unsupported_capability", AGENT_EXIT_CODES.conflict],
    ["session_locked", AGENT_EXIT_CODES.conflict],
    ["session_busy", AGENT_EXIT_CODES.conflict],
    ["session_not_found", AGENT_EXIT_CODES.conflict],
    ["timeout", AGENT_EXIT_CODES.timeout],
    ["idle_timeout", AGENT_EXIT_CODES.timeout],
    ["cancelled", AGENT_EXIT_CODES.sigint],
    ["interrupted", AGENT_EXIT_CODES.sigterm],
    ["provider_error", AGENT_EXIT_CODES.runtimeFailure],
    ["transport_error", AGENT_EXIT_CODES.runtimeFailure],
    ["runtime_error", AGENT_EXIT_CODES.runtimeFailure],
    ["tool_error", AGENT_EXIT_CODES.runtimeFailure],
  ] as const)("maps %s to %i", (code, expected) => {
    expect(exitCodeForError({ code, message: "m" })).toBe(expected)
  })

  it("covers every declared error code", () => {
    for (const code of AGENT_ERROR_CODES) {
      expect(typeof exitCodeForError({ code, message: "m" })).toBe("number")
    }
  })
})
