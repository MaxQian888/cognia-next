/**
 * @jest-environment jsdom
 */

import { makeSubagentEmitter, nudgeProgress } from "./subagent-event-emitter"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgent } from "@/types/agent/sub-agent"

function seed(id: string): void {
  const now = new Date()
  useSubagentRuntimeStore.getState().upsert({
    id,
    parentAgentId: "p",
    name: id,
    description: id,
    task: "t",
    initialTask: "t",
    threadId: id,
    status: "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 0,
    createdAt: now,
    lastActivityAt: now,
    retryCount: 0,
    order: 0,
  } as unknown as SubAgent)
}

describe("nudgeProgress", () => {
  it("approaches 95 monotonically and never exceeds it", () => {
    let p = 0
    for (let i = 0; i < 100; i++) p = nudgeProgress(p)
    expect(p).toBeGreaterThan(90)
    expect(p).toBeLessThanOrEqual(95)
  })

  it("first nudge from 0 is 14.25", () => {
    expect(nudgeProgress(0)).toBeCloseTo(14.25, 5)
  })
})

describe("makeSubagentEmitter", () => {
  beforeEach(() => useSubagentRuntimeStore.getState().clearRuntime())

  it("logs tool calls and results and nudges progress on results", () => {
    seed("a")
    const emit = makeSubagentEmitter("a")
    emit({ type: "tool-call", toolName: "Read", input: { file: "x" } })
    emit({ type: "tool-result", toolName: "Read", result: "ok", isError: false })
    const sa = useSubagentRuntimeStore.getState().subAgents["a"]!
    expect(sa.logs.map((l) => l.message)).toEqual(["Read", "Read"])
    expect(sa.logs[0].data).toEqual({ file: "x" })
    expect(sa.progress).toBeCloseTo(14.25, 5)
  })

  it("marks an errored tool-result at error level", () => {
    seed("a")
    const emit = makeSubagentEmitter("a")
    emit({ type: "tool-result", toolName: "Bash", result: "boom", isError: true })
    expect(useSubagentRuntimeStore.getState().subAgents["a"]!.logs[0].level).toBe("error")
  })

  it("coalesces streaming text deltas into one growing log entry", () => {
    seed("a")
    const emit = makeSubagentEmitter("a")
    emit({ type: "text-delta", delta: "Hel" })
    emit({ type: "text-delta", delta: "lo" })
    const logs = useSubagentRuntimeStore.getState().subAgents["a"]!.logs
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe("Hello")
  })

  it("ignores thinking-delta, usage, compact and never throws on a missing node", () => {
    const emit = makeSubagentEmitter("ghost")
    expect(() => {
      emit({ type: "thinking-delta", delta: "x" })
      emit({ type: "usage", usage: { input_tokens: 1, output_tokens: 2 } as never })
      emit({ type: "tool-call", toolName: "Read", input: {} })
    }).not.toThrow()
    expect(useSubagentRuntimeStore.getState().subAgents["ghost"]).toBeUndefined()
  })
})
