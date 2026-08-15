import {
  ChatTurnPerformanceRecorder,
  type ChatTurnPerformanceMeasure,
} from "./chat-turn-performance"

function createHarness() {
  let now = 0
  const measures: ChatTurnPerformanceMeasure[] = []
  const recorder = new ChatTurnPerformanceRecorder({
    now: () => now,
    measure: (measure) => measures.push(measure),
  })

  return {
    recorder,
    measures,
    advanceTo(value: number) {
      now = value
    },
  }
}

describe("ChatTurnPerformanceRecorder", () => {
  it("records the complete successful turn lifecycle", () => {
    const h = createHarness()

    h.advanceTo(10)
    h.recorder.begin("session-a")
    h.advanceTo(20)
    h.recorder.markDispatched("session-a")
    h.advanceTo(55)
    h.recorder.markFirstResponse("session-a")
    h.advanceTo(80)
    h.recorder.beginFinalPersistence("session-a")
    h.advanceTo(92)
    h.recorder.endFinalPersistence("session-a")
    h.advanceTo(100)
    h.recorder.finish("session-a", "completed")

    expect(h.measures).toEqual([
      { name: "chat:dispatch-latency", startTime: 10, endTime: 20 },
      { name: "chat:time-to-first-response", startTime: 10, endTime: 55 },
      { name: "chat:final-persistence", startTime: 80, endTime: 92 },
      { name: "chat:response-stream", startTime: 55, endTime: 100 },
      { name: "chat:turn", startTime: 10, endTime: 100 },
      { name: "chat:turn:completed", startTime: 10, endTime: 100 },
    ])
  })

  it.each(["failed", "cancelled"] as const)(
    "records a terminal %s turn even when no response arrived",
    (outcome) => {
      const h = createHarness()

      h.advanceTo(5)
      h.recorder.begin("session-a")
      h.advanceTo(15)
      h.recorder.markDispatched("session-a")
      h.advanceTo(40)
      h.recorder.finish("session-a", outcome)

      expect(h.measures).toEqual([
        { name: "chat:dispatch-latency", startTime: 5, endTime: 15 },
        { name: "chat:turn", startTime: 5, endTime: 40 },
        { name: `chat:turn:${outcome}`, startTime: 5, endTime: 40 },
      ])
    }
  )

  it("keeps concurrent sessions isolated", () => {
    const h = createHarness()

    h.advanceTo(0)
    h.recorder.begin("session-a")
    h.advanceTo(10)
    h.recorder.begin("session-b")
    h.advanceTo(20)
    h.recorder.markDispatched("session-b")
    h.advanceTo(30)
    h.recorder.markDispatched("session-a")
    h.advanceTo(40)
    h.recorder.markFirstResponse("session-a")
    h.advanceTo(50)
    h.recorder.markFirstResponse("session-b")
    h.advanceTo(70)
    h.recorder.finish("session-b", "completed")
    h.advanceTo(90)
    h.recorder.finish("session-a", "completed")

    expect(h.measures).toContainEqual({
      name: "chat:time-to-first-response",
      startTime: 0,
      endTime: 40,
    })
    expect(h.measures).toContainEqual({
      name: "chat:time-to-first-response",
      startTime: 10,
      endTime: 50,
    })
    expect(h.measures).toContainEqual({ name: "chat:turn", startTime: 10, endTime: 70 })
    expect(h.measures).toContainEqual({ name: "chat:turn", startTime: 0, endTime: 90 })
  })

  it("does not reset an active turn when a fallback re-enters send", () => {
    const h = createHarness()

    h.advanceTo(10)
    h.recorder.begin("session-a")
    h.advanceTo(25)
    h.recorder.markDispatched("session-a")
    h.advanceTo(50)
    h.recorder.begin("session-a")
    h.advanceTo(60)
    h.recorder.markDispatched("session-a")
    h.advanceTo(90)
    h.recorder.markFirstResponse("session-a")
    h.advanceTo(120)
    h.recorder.finish("session-a", "completed")

    expect(h.measures).toContainEqual({
      name: "chat:dispatch-latency",
      startTime: 10,
      endTime: 25,
    })
    expect(h.measures).toContainEqual({
      name: "chat:time-to-first-response",
      startTime: 10,
      endTime: 90,
    })
    expect(h.measures).toContainEqual({ name: "chat:turn", startTime: 10, endTime: 120 })
    expect(h.measures.filter((measure) => measure.name === "chat:dispatch-latency")).toHaveLength(1)
  })

  it("is idempotent for duplicate lifecycle events and unknown sessions", () => {
    const h = createHarness()

    h.recorder.markDispatched("missing")
    h.recorder.markFirstResponse("missing")
    h.recorder.beginFinalPersistence("missing")
    h.recorder.endFinalPersistence("missing")
    h.recorder.finish("missing", "completed")

    h.recorder.begin("session-a")
    h.advanceTo(10)
    h.recorder.markDispatched("session-a")
    h.advanceTo(20)
    h.recorder.markDispatched("session-a")
    h.recorder.markFirstResponse("session-a")
    h.advanceTo(30)
    h.recorder.markFirstResponse("session-a")
    h.recorder.beginFinalPersistence("session-a")
    h.advanceTo(40)
    h.recorder.beginFinalPersistence("session-a")
    h.recorder.endFinalPersistence("session-a")
    h.advanceTo(50)
    h.recorder.endFinalPersistence("session-a")
    h.recorder.finish("session-a", "completed")
    h.recorder.finish("session-a", "completed")

    expect(h.measures.filter((measure) => measure.name === "chat:dispatch-latency")).toHaveLength(1)
    expect(
      h.measures.filter((measure) => measure.name === "chat:time-to-first-response")
    ).toHaveLength(1)
    expect(h.measures.filter((measure) => measure.name === "chat:final-persistence")).toHaveLength(
      1
    )
    expect(h.measures.filter((measure) => measure.name === "chat:turn")).toHaveLength(1)
  })

  it("records a duplicate-command ack as a zero-length dedupe range, with or without an active turn (ADR-0127)", () => {
    const { recorder, measures, advanceTo } = createHarness()
    // No turn is active — a retried interrupt after the seal must still count.
    advanceTo(40)
    recorder.markCommandDeduped("s1")
    expect(measures).toEqual([{ name: "chat:command-dedupe", startTime: 40, endTime: 40 }])
    // Inside a turn it does not disturb the turn lifecycle measures.
    recorder.begin("s1")
    advanceTo(50)
    recorder.markCommandDeduped("s1")
    recorder.markCommandDeduped("")
    advanceTo(60)
    recorder.finish("s1", "completed")
    expect(measures.map((m) => m.name)).toEqual([
      "chat:command-dedupe",
      "chat:command-dedupe",
      "chat:turn",
      "chat:turn:completed",
    ])
  })

  it("closes an in-flight final persistence measure on terminal failure", () => {
    const h = createHarness()

    h.recorder.begin("session-a")
    h.advanceTo(10)
    h.recorder.beginFinalPersistence("session-a")
    h.advanceTo(25)
    h.recorder.finish("session-a", "failed")

    expect(h.measures).toContainEqual({
      name: "chat:final-persistence",
      startTime: 10,
      endTime: 25,
    })
  })
})
