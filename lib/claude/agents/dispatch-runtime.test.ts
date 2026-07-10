import {
  recordDispatchStart,
  recordDispatchComplete,
  recordDispatchFailed,
  recordDispatchCancelled,
  recordDispatchRejected,
  recordDispatchRetry,
  createDispatchRunTracker,
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

  it("marks a run failed with the envelope message + structured detail", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    recordDispatchFailed("n1", { code: "server-error", retryable: true, message: "boom" })
    const sa = read("n1")
    expect(sa.status).toBe("failed")
    expect(sa.error).toBe("boom")
    expect(sa.errorEnvelope).toEqual({ code: "server-error", retryable: true })
    expect(sa.result).toBeUndefined()
  })

  it("salvages partial output onto the failed run's result", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    recordDispatchFailed("n1", {
      code: "rate-limit",
      retryable: true,
      message: "429",
      partialText: "half the answer",
    })
    const sa = read("n1")
    expect(sa.status).toBe("failed")
    expect(sa.errorEnvelope?.partialText).toBe("half the answer")
    expect(sa.result).toMatchObject({ success: false, finalResponse: "half the answer" })
  })

  it("ignores failure for an unknown run", () => {
    recordDispatchFailed("ghost", { code: "unknown", retryable: false, message: "boom" })
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

describe("recordDispatchRetry", () => {
  beforeEach(() => useSubagentRuntimeStore.getState().clearRuntime())

  it("bumps retryCount, keeps the run running, and logs a warn line", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    recordDispatchRetry("n1", 1, { code: "rate-limit", retryable: true, message: "429" }, 2)
    const sa = read("n1")
    expect(sa.status).toBe("running")
    expect(sa.retryCount).toBe(1)
    expect(sa.logs.at(-1)).toMatchObject({
      level: "warn",
      message: "Retrying after rate-limit (attempt 1/2): 429",
    })
  })

  it("omits the /max suffix when maxRetries is not given", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    recordDispatchRetry("n1", 2, { code: "network", retryable: true, message: "ECONNRESET" })
    expect(read("n1").logs.at(-1)?.message).toBe("Retrying after network (attempt 2): ECONNRESET")
  })

  it("ignores retries for an unknown run", () => {
    recordDispatchRetry("ghost", 1, { code: "network", retryable: true, message: "x" })
    expect(read("ghost")).toBeUndefined()
  })
})

describe("createDispatchRunTracker", () => {
  beforeEach(() => useSubagentRuntimeStore.getState().clearRuntime())

  it("logs and bumps the honest tool-use count on each tool-call (gap9: no progress bar)", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const { sink } = createDispatchRunTracker("n1")
    sink({ type: "tool-call", toolName: "Bash", input: {} })
    sink({ type: "tool-call", toolName: "Read", input: {} })
    const sa = read("n1")
    expect(sa.logs.map((l) => l.message)).toEqual(["Running Bash", "Running Read"])
    expect(sa.toolUses).toBe(2) // honest raw count
    expect(sa.progress).toBe(0) // pseudo-percentage no longer advanced (seed only)
  })

  it("logs tool results, warning on errors", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const { sink } = createDispatchRunTracker("n1")
    sink({ type: "tool-result", toolName: "Bash", result: "ok" })
    sink({ type: "tool-result", toolName: "Read", result: "no", isError: true })
    const logs = read("n1").logs
    expect(logs[0]).toMatchObject({ level: "info" })
    expect(logs[1]).toMatchObject({ level: "warn" })
  })

  it("populates the inline tool list (toolStart/toolEnd) keyed by id", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const { sink } = createDispatchRunTracker("n1")
    sink({ type: "tool-call", toolName: "Read", input: { p: 1 }, id: "tc-a" })
    sink({ type: "tool-result", toolName: "Read", result: "ok", id: "tc-a" })
    const calls = read("n1").toolCalls!
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ id: "tc-a", name: "Read", state: "done", output: "ok" })
  })

  it("pairs result to call by name when the SDK omits ids", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const { sink } = createDispatchRunTracker("n1")
    sink({ type: "tool-call", toolName: "Grep", input: {} })
    sink({ type: "tool-result", toolName: "Grep", result: "5", isError: false })
    const calls = read("n1").toolCalls!
    expect(calls).toHaveLength(1)
    expect(calls[0].state).toBe("done")
  })

  it("retains streamed text for partial-output salvage (tail-capped)", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const tracker = createDispatchRunTracker("n1")
    tracker.sink({ type: "text-delta", delta: "hello " })
    tracker.sink({ type: "text-delta", delta: "world" })
    expect(tracker.partialText()).toBe("hello world")
  })

  it("caps the retained text buffer to the tail", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const tracker = createDispatchRunTracker("n1")
    tracker.sink({ type: "text-delta", delta: "x".repeat(40_000) })
    tracker.sink({ type: "text-delta", delta: "END" })
    const text = tracker.partialText()
    expect(text.length).toBeLessThanOrEqual(32 * 1024)
    expect(text.endsWith("END")).toBe(true)
  })

  it("flushes coalesced stream text into the run's log line (throttled)", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const { sink } = createDispatchRunTracker("n1")
    sink({ type: "text-delta", delta: "tiny" }) // below the flush step — no write
    expect(read("n1").logs).toHaveLength(0)
    sink({ type: "text-delta", delta: "y".repeat(100) }) // crosses the step
    const logs = read("n1").logs
    expect(logs).toHaveLength(1)
    expect(logs[0].data).toMatchObject({ stream: "text" })
    expect(logs[0].message).toBe(`tiny${"y".repeat(100)}`)
  })

  it("folds a final usage event into the live store figure", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const tracker = createDispatchRunTracker("n1")
    tracker.sink({ type: "usage", usage: { inputTokens: 100, outputTokens: 20 } })
    expect(tracker.liveUsage()).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    })
    expect(read("n1").tokenUsage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    })
  })

  it("SUMS partial usage snapshots and lets the final authoritative usage REPLACE the sum", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const tracker = createDispatchRunTracker("n1")
    const partial = (inputTokens: number, outputTokens: number) =>
      ({ type: "usage", usage: { inputTokens, outputTokens }, partial: true }) as never
    tracker.sink(partial(100, 10))
    tracker.sink(partial(150, 20))
    expect(tracker.liveUsage()).toEqual({
      promptTokens: 250,
      completionTokens: 30,
      totalTokens: 280,
    })
    tracker.sink({ type: "usage", usage: { inputTokens: 260, outputTokens: 35 } })
    expect(tracker.liveUsage()).toEqual({
      promptTokens: 260,
      completionTokens: 35,
      totalTokens: 295,
    })
    expect(read("n1").tokenUsage?.totalTokens).toBe(295)
  })

  it("ignores thinking deltas", () => {
    recordDispatchStart({ id: "n1", name: "coder", task: "do", depth: 1 })
    const tracker = createDispatchRunTracker("n1")
    tracker.sink({ type: "thinking-delta", delta: "hmm" })
    expect(read("n1").logs).toHaveLength(0)
    expect(tracker.partialText()).toBe("")
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
