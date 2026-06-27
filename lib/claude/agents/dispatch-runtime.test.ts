import {
  recordDispatchStart,
  recordDispatchComplete,
  recordDispatchFailed,
  recordDispatchCancelled,
  recordDispatchRejected,
  dispatchProgressForToolCount,
  createDispatchEventSink,
} from "./dispatch-runtime"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

const read = (id: string) => useSubagentRuntimeStore.getState().subAgents[id]

describe("dispatch-runtime producer", () => {
  beforeEach(() => {
    useSubagentRuntimeStore.getState().clearRuntime()
  })

  it("records a running run with depth + parent edge", () => {
    recordDispatchStart({
      id: "n1",
      name: "researcher",
      task: "find X",
      depth: 2,
      parentSubagentId: "n0",
      backgrounded: true,
    })
    const sa = read("n1")
    expect(sa.status).toBe("running")
    expect(sa.depth).toBe(2)
    expect(sa.parentSubagentId).toBe("n0")
    expect(sa.backgrounded).toBe(true)
    expect(sa.task).toBe("find X")
  })

  it("threads parentSessionId onto context.sessionId for the chat-side bridge", () => {
    recordDispatchStart({
      id: "n2",
      name: "researcher",
      task: "t",
      depth: 1,
      parentSessionId: "sess-42",
    })
    expect(read("n2").context?.sessionId).toBe("sess-42")
  })

  it("omits context when no parentSessionId is provided", () => {
    recordDispatchStart({ id: "n3", name: "researcher", task: "t", depth: 1 })
    expect(read("n3").context).toBeUndefined()
  })

  it("completes a run with text + token usage", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    recordDispatchComplete("n1", {
      text: "result text",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
    const sa = read("n1")
    expect(sa.status).toBe("completed")
    expect(sa.progress).toBe(100)
    expect(sa.backgrounded).toBe(false)
    expect(sa.result?.finalResponse).toBe("result text")
    expect(sa.result?.tokenUsage?.totalTokens).toBe(15)
  })

  it("ignores completion for an unknown run", () => {
    recordDispatchComplete("ghost", { text: "x" })
    expect(read("ghost")).toBeUndefined()
  })

  it("marks a run failed with an error", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    recordDispatchFailed("n1", "boom")
    const sa = read("n1")
    expect(sa.status).toBe("failed")
    expect(sa.error).toBe("boom")
  })

  it("ignores failure for an unknown run", () => {
    recordDispatchFailed("ghost", "boom")
    expect(read("ghost")).toBeUndefined()
  })

  it("completes a run without usage (no token snapshot)", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    recordDispatchComplete("n1", { text: "ok" })
    const sa = read("n1")
    expect(sa.status).toBe("completed")
    expect(sa.result?.tokenUsage).toBeUndefined()
  })

  it("records a rejected dispatch with the rejection reason", () => {
    recordDispatchRejected({
      id: "n1",
      name: "coder",
      task: "do",
      depth: 3,
      rejection: { reason: "max-depth", message: "too deep", attemptedDepth: 3 },
    })
    const sa = read("n1")
    expect(sa.status).toBe("rejected")
    expect(sa.rejection?.reason).toBe("max-depth")
  })
})

describe("dispatchProgressForToolCount", () => {
  it("is 0 for no tools and rises monotonically, capped below 100", () => {
    expect(dispatchProgressForToolCount(0)).toBe(0)
    expect(dispatchProgressForToolCount(1)).toBe(10)
    expect(dispatchProgressForToolCount(5)).toBe(50)
    expect(dispatchProgressForToolCount(99)).toBeLessThan(100)
    expect(dispatchProgressForToolCount(99)).toBeGreaterThanOrEqual(dispatchProgressForToolCount(5))
  })
})

describe("createDispatchEventSink", () => {
  beforeEach(() => useSubagentRuntimeStore.getState().clearRuntime())

  it("logs and advances progress on each tool-call", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const sink = createDispatchEventSink("n1")
    sink({ type: "tool-call", toolName: "Bash", input: {} })
    sink({ type: "tool-call", toolName: "Read", input: {} })
    const sa = read("n1")
    expect(sa.logs.map((l) => l.message)).toEqual(["Running Bash", "Running Read"])
    expect(sa.progress).toBe(20) // derived pseudo-percentage
    expect(sa.toolUses).toBe(2) // honest raw count
  })

  it("logs tool results, warning on errors", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const sink = createDispatchEventSink("n1")
    sink({ type: "tool-result", toolName: "Bash", result: "ok" })
    sink({ type: "tool-result", toolName: "Read", result: "no", isError: true })
    const logs = read("n1").logs
    expect(logs[0]).toMatchObject({ level: "info" })
    expect(logs[1]).toMatchObject({ level: "warn" })
  })

  it("ignores non-tool events", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const sink = createDispatchEventSink("n1")
    sink({ type: "text-delta", delta: "hello" })
    sink({ type: "usage", usage: {} as never })
    expect(read("n1").logs).toHaveLength(0)
  })

  it("populates the inline tool list (toolStart/toolEnd) keyed by id", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const sink = createDispatchEventSink("n1")
    sink({ type: "tool-call", toolName: "Read", input: { p: 1 }, id: "tc-a" })
    sink({ type: "tool-result", toolName: "Read", result: "ok", id: "tc-a" })
    const calls = read("n1").toolCalls!
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ id: "tc-a", name: "Read", state: "done", output: "ok" })
  })

  it("pairs result to call by name when the SDK omits ids", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const sink = createDispatchEventSink("n1")
    sink({ type: "tool-call", toolName: "Grep", input: {} })
    sink({ type: "tool-result", toolName: "Grep", result: "5", isError: false })
    const calls = read("n1").toolCalls!
    expect(calls).toHaveLength(1)
    expect(calls[0].state).toBe("done")
  })
})

describe("recordDispatchCancelled", () => {
  beforeEach(() => useSubagentRuntimeStore.getState().clearRuntime())

  it("marks a run cancelled", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    recordDispatchCancelled("n1")
    expect(read("n1").status).toBe("cancelled")
    expect(read("n1").completedAt).toBeInstanceOf(Date)
  })

  it("ignores cancellation for an unknown run", () => {
    recordDispatchCancelled("ghost")
    expect(useSubagentRuntimeStore.getState().subAgents.ghost).toBeUndefined()
  })
})
