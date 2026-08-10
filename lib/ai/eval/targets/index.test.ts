import * as targets from "./index"

describe("targets barrel", () => {
  it("re-exports the target factories + helpers", () => {
    expect(typeof targets.createChatTarget).toBe("function")
    expect(typeof targets.defaultChatTargetDeps).toBe("function")
    expect(typeof targets.assembleSampleFromSpans).toBe("function")
    expect(typeof targets.createTwinTarget).toBe("function")
    expect(typeof targets.hydrateTwinRetrievalSpans).toBe("function")
    expect(typeof targets.createTeamTarget).toBe("function")
    expect(typeof targets.defaultTeamTargetDeps).toBe("function")
    expect(typeof targets.extractTeamText).toBe("function")
    expect(typeof targets.createWorkflowTarget).toBe("function")
    expect(typeof targets.defaultWorkflowTargetDeps).toBe("function")
    expect(typeof targets.newEvalTraceId).toBe("function")
    expect(typeof targets.createTargetFromSpec).toBe("function")
  })
})
