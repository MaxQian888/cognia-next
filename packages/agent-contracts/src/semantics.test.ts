import {
  UNDECLARED_EXECUTION_SEMANTICS,
  cancelIsolatedToSession,
  executionSemanticsOf,
  requiresReconnectAfterCancel,
  type AgentExecutionSemantics,
} from "./semantics"

const turnShared: AgentExecutionSemantics = {
  cancel: { scope: "turn", reconnectsAfterCancel: false },
  resume: "native",
  fork: "native-turn-boundary",
  approvals: "per-tool-call",
  processModel: "shared",
}

const processPerSession: AgentExecutionSemantics = {
  cancel: { scope: "process", reconnectsAfterCancel: true },
  resume: "unsupported",
  fork: "unsupported",
  approvals: "profile-fixed",
  processModel: "per-session",
}

describe("execution semantics", () => {
  it("falls back to the conservative reading when an adapter declares nothing", () => {
    expect(executionSemanticsOf({})).toBe(UNDECLARED_EXECUTION_SEMANTICS)
    expect(executionSemanticsOf({ semantics: turnShared })).toBe(turnShared)
  })

  it("never reads an undeclared adapter more permissively than it could be", () => {
    expect(UNDECLARED_EXECUTION_SEMANTICS.cancel.scope).toBe("process")
    expect(requiresReconnectAfterCancel(UNDECLARED_EXECUTION_SEMANTICS)).toBe(true)
    expect(cancelIsolatedToSession(UNDECLARED_EXECUTION_SEMANTICS)).toBe(false)
    expect(UNDECLARED_EXECUTION_SEMANTICS.resume).toBe("unsupported")
    expect(UNDECLARED_EXECUTION_SEMANTICS.fork).toBe("unsupported")
    expect(Object.isFrozen(UNDECLARED_EXECUTION_SEMANTICS)).toBe(true)
    expect(Object.isFrozen(UNDECLARED_EXECUTION_SEMANTICS.cancel)).toBe(true)
  })

  it("isolates a process cancel only when each session owns its process", () => {
    expect(cancelIsolatedToSession(turnShared)).toBe(true)
    expect(cancelIsolatedToSession(processPerSession)).toBe(true)
    expect(cancelIsolatedToSession({ ...processPerSession, processModel: "shared" })).toBe(false)
    expect(cancelIsolatedToSession({ ...processPerSession, processModel: "per-turn" })).toBe(true)
  })

  it("requires a reconnect after any cancel that is not turn-scoped", () => {
    expect(requiresReconnectAfterCancel(turnShared)).toBe(false)
    expect(requiresReconnectAfterCancel(processPerSession)).toBe(true)
    expect(
      requiresReconnectAfterCancel({
        ...turnShared,
        cancel: { scope: "session", reconnectsAfterCancel: false },
      })
    ).toBe(true)
    expect(
      requiresReconnectAfterCancel({
        ...turnShared,
        cancel: { scope: "turn", reconnectsAfterCancel: true },
      })
    ).toBe(true)
  })
})
