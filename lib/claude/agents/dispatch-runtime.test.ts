import {
  recordDispatchStart,
  recordDispatchComplete,
  recordDispatchFailed,
  recordDispatchRejected,
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
