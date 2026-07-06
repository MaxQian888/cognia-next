import type { UIMessage } from "ai"

import {
  computeCompactionTokenDeltas,
  deriveContextPhases,
  indexDeltasByBoundary,
  pendingRecoveryPhase,
  phaseOfMessage,
} from "@/lib/usage/compaction-metrics"

function user(id: string, text = "hi"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage
}

function assistant(id: string, windowTokens: number): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "ok" }],
    metadata: { usage: { inputTokens: windowTokens, outputTokens: 0 } },
  } as unknown as UIMessage
}

function boundary(
  id: string,
  data: { preTokens?: number; postTokens?: number; trigger?: string; strategy?: string } = {}
): UIMessage {
  return {
    id,
    role: "system",
    parts: [{ type: "compact-boundary", ...data }],
  } as unknown as UIMessage
}

describe("deriveContextPhases", () => {
  it("returns a single phase 0 when there are no boundaries", () => {
    const messages = [user("u1"), assistant("a1", 100)]
    const phases = deriveContextPhases(messages)
    expect(phases).toHaveLength(1)
    expect(phases[0]).toMatchObject({ phaseNumber: 0, startMessageId: "u1", turnLabel: 0 })
  })

  it("opens a new phase per boundary and records the assistant-turn label", () => {
    const messages = [
      user("u1"),
      assistant("a1", 100),
      assistant("a2", 200),
      boundary("b1", { preTokens: 200, postTokens: 50 }),
      user("u2"),
      assistant("a3", 60),
    ]
    const phases = deriveContextPhases(messages)
    expect(phases).toHaveLength(2)
    expect(phases[0]).toMatchObject({ phaseNumber: 0, startMessageId: "u1", turnLabel: 0 })
    // Two assistant turns happened before the boundary.
    expect(phases[1]).toMatchObject({
      phaseNumber: 1,
      boundaryId: "b1",
      startMessageId: "u2",
      turnLabel: 2,
    })
  })

  it("handles multiple boundaries with incrementing phase numbers", () => {
    const messages = [
      assistant("a1", 100),
      boundary("b1"),
      assistant("a2", 50),
      boundary("b2"),
      user("u3"),
    ]
    const phases = deriveContextPhases(messages)
    expect(phases.map((p) => p.phaseNumber)).toEqual([0, 1, 2])
    expect(phases[1].turnLabel).toBe(1)
    expect(phases[2]).toMatchObject({ phaseNumber: 2, boundaryId: "b2", startMessageId: "u3" })
  })

  it("tolerates an empty message list", () => {
    expect(deriveContextPhases([])).toEqual([
      { phaseNumber: 0, startMessageId: undefined, turnLabel: 0 },
    ])
  })
})

describe("phaseOfMessage", () => {
  const messages = [
    user("u1"),
    assistant("a1", 100),
    boundary("b1"),
    user("u2"),
    boundary("b2"),
    user("u3"),
  ]

  it("returns 0 for messages before any boundary", () => {
    expect(phaseOfMessage(messages, "u1")).toBe(0)
    expect(phaseOfMessage(messages, "a1")).toBe(0)
  })

  it("counts boundaries crossed before the target message", () => {
    expect(phaseOfMessage(messages, "u2")).toBe(1)
    expect(phaseOfMessage(messages, "u3")).toBe(2)
  })

  it("returns 0 for an unknown id", () => {
    expect(phaseOfMessage(messages, "missing")).toBe(0)
  })
})

describe("computeCompactionTokenDeltas", () => {
  it("uses the boundary part's own pre/post tokens when present", () => {
    const messages = [
      assistant("a1", 999),
      boundary("b1", { preTokens: 800, postTokens: 200, trigger: "auto", strategy: "generic" }),
    ]
    const [d] = computeCompactionTokenDeltas(messages)
    expect(d).toMatchObject({
      boundaryId: "b1",
      phaseNumber: 1,
      preCompactionTokens: 800,
      postCompactionTokens: 200,
      delta: 600,
      trigger: "auto",
      strategy: "generic",
    })
    expect(d.effectiveness).toBeCloseTo(0.75)
  })

  it("falls back to surrounding assistant window tokens when the part omits them", () => {
    const messages = [assistant("a1", 500), boundary("b1"), assistant("a2", 120)]
    const [d] = computeCompactionTokenDeltas(messages)
    expect(d.preCompactionTokens).toBe(500)
    expect(d.postCompactionTokens).toBe(120)
    expect(d.delta).toBe(380)
    expect(d.effectiveness).toBeCloseTo(380 / 500)
  })

  it("clamps a negative delta to zero and never divides by zero", () => {
    const messages = [boundary("b1", { preTokens: 0, postTokens: 50 })]
    const [d] = computeCompactionTokenDeltas(messages)
    expect(d.delta).toBe(0)
    expect(d.effectiveness).toBe(0)
  })

  it("numbers deltas per boundary across the session", () => {
    const messages = [
      boundary("b1", { preTokens: 100, postTokens: 10 }),
      boundary("b2", { preTokens: 80, postTokens: 8 }),
    ]
    const deltas = computeCompactionTokenDeltas(messages)
    expect(deltas.map((d) => d.phaseNumber)).toEqual([1, 2])
  })

  it("returns an empty list when there are no boundaries", () => {
    expect(computeCompactionTokenDeltas([user("u1"), assistant("a1", 10)])).toEqual([])
  })
})

describe("pendingRecoveryPhase", () => {
  it("returns null when there are no boundaries", () => {
    expect(pendingRecoveryPhase([user("u1"), assistant("a1", 10)])).toBeNull()
  })

  it("returns the phase number when the latest boundary has no assistant after it", () => {
    const messages = [assistant("a1", 100), boundary("b1"), user("u2")]
    expect(pendingRecoveryPhase(messages)).toBe(1)
  })

  it("returns null once the assistant has responded in the new phase", () => {
    const messages = [assistant("a1", 100), boundary("b1"), user("u2"), assistant("a2", 30)]
    expect(pendingRecoveryPhase(messages)).toBeNull()
  })

  it("counts all boundaries for the phase number", () => {
    const messages = [boundary("b1"), assistant("a1", 50), boundary("b2"), user("u3")]
    expect(pendingRecoveryPhase(messages)).toBe(2)
  })
})

describe("indexDeltasByBoundary", () => {
  it("keys deltas by their boundary id", () => {
    const messages = [boundary("b1", { preTokens: 100, postTokens: 10 })]
    const index = indexDeltasByBoundary(computeCompactionTokenDeltas(messages))
    expect(index.get("b1")?.delta).toBe(90)
    expect(index.has("nope")).toBe(false)
  })
})
