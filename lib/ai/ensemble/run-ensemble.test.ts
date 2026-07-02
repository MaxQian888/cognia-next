import { runEnsemble, type RunEnsembleDeps, type RunEnsembleSampleInput } from "./run-ensemble"

function depsReturning(
  outputs: Array<{ text?: string; object?: unknown } | Error>,
  synthesize?: RunEnsembleDeps["synthesize"]
): RunEnsembleDeps {
  return {
    runSample: jest.fn(async ({ index }) => {
      const out = outputs[index]
      if (out instanceof Error) throw out
      return out
    }),
    ...(synthesize ? { synthesize } : {}),
  }
}

describe("runEnsemble", () => {
  it("rejects n < 1", async () => {
    await expect(
      runEnsemble({ n: 0, aggregation: { kind: "majority-vote-on-field" } }, depsReturning([]))
    ).rejects.toThrow(/n must be/)
  })

  it("runs N samples and returns them all", async () => {
    const deps = depsReturning([{ text: "a" }, { text: "b" }, { text: "c" }])
    const r = await runEnsemble({ n: 3, aggregation: { kind: "majority-vote-on-field" } }, deps)
    expect(r.totalCount).toBe(3)
    expect(r.respondedCount).toBe(3)
    expect(r.samples.map((s) => s.text)).toEqual(["a", "b", "c"])
  })

  it("majority-vote-on-field picks the mode", async () => {
    const deps = depsReturning([
      { object: { v: "yes" } },
      { object: { v: "no" } },
      { object: { v: "yes" } },
    ])
    const r = await runEnsemble(
      { n: 3, aggregation: { kind: "majority-vote-on-field", field: "v" } },
      deps
    )
    expect(r.result).toEqual({ value: "yes", count: 2, total: 3 })
  })

  it("majority vote breaks ties by first-seen", async () => {
    const deps = depsReturning([{ object: { v: "b" } }, { object: { v: "a" } }])
    const r = await runEnsemble(
      { n: 2, aggregation: { kind: "majority-vote-on-field", field: "v" } },
      deps
    )
    expect((r.result as { value: string }).value).toBe("b")
  })

  it("threshold-count tests equality against a target", async () => {
    const deps = depsReturning([
      { object: { ok: true } },
      { object: { ok: true } },
      { object: { ok: false } },
    ])
    const r = await runEnsemble(
      { n: 3, aggregation: { kind: "threshold-count", field: "ok", equals: true, threshold: 2 } },
      deps
    )
    expect(r.result).toEqual({ passed: true, count: 2, threshold: 2 })
  })

  it("best-of-by-score picks the highest score", async () => {
    const deps = depsReturning([
      { object: { score: 3, answer: "x" } },
      { object: { score: 9, answer: "y" } },
      { object: { score: 1, answer: "z" } },
    ])
    const r = await runEnsemble(
      { n: 3, aggregation: { kind: "best-of-by-score", scoreField: "score" } },
      deps
    )
    expect(r.result).toEqual({ winner: { score: 9, answer: "y" }, score: 9, index: 1 })
  })

  it("synthesize-by-final-agent calls the synthesizer", async () => {
    const synthesize = jest.fn(async () => ({ text: "merged answer" }))
    const deps = depsReturning([{ text: "one" }, { text: "two" }], synthesize)
    const r = await runEnsemble(
      { n: 2, aggregation: { kind: "synthesize-by-final-agent", instructions: "be terse" } },
      deps
    )
    expect(r.result).toBe("merged answer")
    expect(synthesize).toHaveBeenCalledWith(expect.any(Array), "be terse")
  })

  it("throws when synthesize policy lacks a synthesizer dep", async () => {
    await expect(
      runEnsemble(
        { n: 1, aggregation: { kind: "synthesize-by-final-agent" } },
        depsReturning([{ text: "x" }])
      )
    ).rejects.toThrow(/requires deps.synthesize/)
  })

  it("tolerates failed samples without throwing", async () => {
    const deps = depsReturning([
      { object: { v: "yes" } },
      new Error("boom"),
      { object: { v: "yes" } },
    ])
    const r = await runEnsemble(
      { n: 3, aggregation: { kind: "majority-vote-on-field", field: "v" } },
      deps
    )
    expect(r.respondedCount).toBe(2)
    expect(r.samples[1].status).toBe("failed")
    expect(r.result).toEqual({ value: "yes", count: 2, total: 2 })
  })

  it("returns null when all samples fail", async () => {
    const deps = depsReturning([new Error("a"), new Error("b")])
    const r = await runEnsemble(
      { n: 2, aggregation: { kind: "best-of-by-score", scoreField: "s" } },
      deps
    )
    expect(r.result).toBeNull()
    expect(r.respondedCount).toBe(0)
  })

  it("cycles lenses across samples", async () => {
    const runSample = jest.fn(async (_input: RunEnsembleSampleInput) => ({ text: "x" }))
    await runEnsemble(
      { n: 4, lens: ["refute", "support"], aggregation: { kind: "majority-vote-on-field" } },
      { runSample }
    )
    const lenses = runSample.mock.calls.map((c) => c[0].lens)
    expect(lenses).toEqual(["refute", "support", "refute", "support"])
  })
})
