import { createSubAgentNode, indeterminateSubagentProgress } from "./subagent-projection"

describe("indeterminateSubagentProgress", () => {
  it("is 0 for no tools and rises 10% per tool", () => {
    expect(indeterminateSubagentProgress(0)).toBe(0)
    expect(indeterminateSubagentProgress(1)).toBe(10)
    expect(indeterminateSubagentProgress(5)).toBe(50)
  })

  it("caps at 95 and floors at 0", () => {
    expect(indeterminateSubagentProgress(99)).toBe(95)
    expect(indeterminateSubagentProgress(-3)).toBe(0)
  })

  it("is monotonic", () => {
    expect(indeterminateSubagentProgress(9)).toBeGreaterThanOrEqual(
      indeterminateSubagentProgress(3)
    )
  })
})

describe("createSubAgentNode", () => {
  it("seeds a fresh running node with synchronized timestamps", () => {
    const n = createSubAgentNode({
      id: "r1",
      name: "coder",
      task: "build",
      parentAgentId: "__chat__",
      depth: 1,
    })
    expect(n).toMatchObject({
      id: "r1",
      threadId: "r1",
      name: "coder",
      description: "coder",
      task: "build",
      initialTask: "build",
      parentAgentId: "__chat__",
      status: "running",
      progress: 0,
      toolUses: 0,
      depth: 1,
      logs: [],
      messages: [],
      sources: [],
      retryCount: 0,
      order: 0,
    })
    expect(n.createdAt).toBeInstanceOf(Date)
    expect(n.startedAt).toBe(n.createdAt)
    expect(n.lastActivityAt).toBe(n.createdAt)
  })

  it("omits optional fields by default", () => {
    const n = createSubAgentNode({
      id: "r1",
      name: "x",
      task: "t",
      parentAgentId: "p",
      depth: 2,
    })
    expect(n).not.toHaveProperty("parentSubagentId")
    expect(n).not.toHaveProperty("context")
    expect(n).not.toHaveProperty("backgrounded")
  })

  it("builds a context block from sessionId", () => {
    const n = createSubAgentNode({
      id: "r1",
      name: "x",
      task: "t",
      parentAgentId: "p",
      depth: 1,
      sessionId: "chat-9",
    })
    expect(n.context).toMatchObject({
      parentAgentId: "p",
      sessionId: "chat-9",
      currentStep: 0,
    })
    expect(n.context?.startTime).toBe(n.createdAt)
  })

  it("threads the tree edge and background flag when provided", () => {
    const n = createSubAgentNode({
      id: "r2",
      name: "x",
      task: "t",
      parentAgentId: "p",
      depth: 3,
      parentSubagentId: "run-A",
      backgrounded: true,
    })
    expect(n.parentSubagentId).toBe("run-A")
    expect(n.backgrounded).toBe(true)
  })
})
