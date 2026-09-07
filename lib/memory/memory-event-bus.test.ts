import { emitMemoryWritten, onMemoryWritten, type MemoryWrittenEvent } from "./memory-event-bus"

function event(over: Partial<MemoryWrittenEvent> = {}): MemoryWrittenEvent {
  return {
    memoryId: "m1",
    type: "semantic",
    scope: "global",
    provenance: "explicit",
    importance: 5,
    at: 1000,
    ...over,
  } as MemoryWrittenEvent
}

describe("memory event bus", () => {
  it("delivers and stops on dispose", () => {
    const seen: string[] = []
    const off = onMemoryWritten((e) => seen.push(e.memoryId))
    emitMemoryWritten(event())
    off()
    emitMemoryWritten(event({ memoryId: "m2" }))
    expect(seen).toEqual(["m1"])
  })

  it("carries the write origin so a runner can refuse its own write", () => {
    let received: MemoryWrittenEvent | undefined
    const off = onMemoryWritten((e) => {
      received = e
    })
    emitMemoryWritten(event({ origin: { workflowId: "wf1", runId: "run1", chainDepth: 2 } }))
    off()
    expect(received?.origin).toEqual({ workflowId: "wf1", runId: "run1", chainDepth: 2 })
  })

  it("has no field that could carry the memory text", () => {
    // The type is the guard: durable facts about the user have no safe subset,
    // so there is deliberately nowhere on this event to put one.
    const keys = Object.keys(event({ key: "always-x", sourceChannel: "workflow" }))
    expect(keys).not.toContain("text")
    expect(keys).not.toContain("content")
  })

  it("keeps a throwing handler from taking its siblings down", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const seen: string[] = []
    const offBad = onMemoryWritten(() => {
      throw new Error("broken")
    })
    const offGood = onMemoryWritten((e) => seen.push(e.memoryId))
    expect(() => emitMemoryWritten(event())).not.toThrow()
    expect(seen).toEqual(["m1"])
    offBad()
    offGood()
    spy.mockRestore()
  })
})
