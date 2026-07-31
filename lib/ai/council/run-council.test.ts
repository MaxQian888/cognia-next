import {
  runCouncil,
  formatCouncillorPrompt,
  formatCouncillorResults,
  parseConfidence,
  renderCouncilReport,
  COUNCIL_SYNTHESIS_SYSTEM,
  type CouncilOptions,
  type RunCouncilDeps,
  type RunPromptInput,
} from "./run-council"

/** Fake runPrompt: councillor aliases echo a canned line; the synthesizer
 *  (identified by the synthesis system prompt) returns a report. */
function makeDeps(
  overrides: {
    perAlias?: Record<string, () => Promise<{ completion: string; model?: string }>>
    synth?: string
  } = {}
): { deps: RunCouncilDeps; calls: RunPromptInput[] } {
  const calls: RunPromptInput[] = []
  const deps: RunCouncilDeps = {
    runPrompt: async (input) => {
      calls.push(input)
      if (input.systemPrompt?.startsWith(COUNCIL_SYNTHESIS_SYSTEM.slice(0, 20))) {
        return {
          completion:
            overrides.synth ??
            "## Council Response\nDo X.\n## Council Summary\nConfidence: majority",
          model: "synth-model",
          provider: "openai",
        }
      }
      const fn = overrides.perAlias?.[input.modelAlias]
      if (fn) return fn()
      return { completion: `answer from ${input.modelAlias}`, model: input.modelAlias }
    },
  }
  return { deps, calls }
}

const baseOpts: CouncilOptions = {
  prompt: "Should we use a queue or an outbox?",
  councillors: [
    { name: "alpha", modelAlias: "fast" },
    { name: "beta", modelAlias: "smart" },
  ],
  synthesizerAlias: "synth",
}

describe("runCouncil", () => {
  it("fans out councillors and synthesizes a report with parsed confidence", async () => {
    const { deps, calls } = makeDeps()
    const res = await runCouncil(baseOpts, deps)

    expect(res.totalCount).toBe(2)
    expect(res.respondedCount).toBe(2)
    expect(res.confidence).toBe("majority")
    expect(res.synthesizerModel).toBe("synth-model")
    expect(res.markdown).toMatch(/Council Response/)
    // 2 councillor calls + 1 synthesizer call.
    expect(calls).toHaveLength(3)
    expect(calls.filter((c) => c.systemPrompt).length).toBe(1)
  })

  it("prepends a councillor system prompt as role guidance", async () => {
    const { deps, calls } = makeDeps()
    await runCouncil(
      {
        ...baseOpts,
        councillors: [{ name: "reviewer", modelAlias: "fast", systemPrompt: "Focus on bugs." }],
      },
      deps
    )
    const councillorCall = calls.find((c) => !c.systemPrompt)
    expect(councillorCall?.userPrompt).toMatch(/Focus on bugs\./)
    expect(councillorCall?.userPrompt).toMatch(/queue or an outbox/)
  })

  it("runs serially when executionMode is 'serial'", async () => {
    const order: string[] = []
    const perAlias = {
      fast: async () => {
        order.push("fast-start")
        await new Promise((r) => setTimeout(r, 10))
        order.push("fast-end")
        return { completion: "a" }
      },
      smart: async () => {
        order.push("smart-start")
        return { completion: "b" }
      },
    }
    const { deps } = makeDeps({ perAlias })
    await runCouncil({ ...baseOpts, executionMode: "serial" }, deps)
    // Serial → fast fully finishes before smart starts.
    expect(order).toEqual(["fast-start", "fast-end", "smart-start"])
  })

  it("records a failed councillor but still synthesizes from the survivors", async () => {
    const perAlias = {
      smart: async () => {
        throw new Error("provider down")
      },
    }
    const { deps } = makeDeps({ perAlias })
    const res = await runCouncil(baseOpts, deps)
    expect(res.respondedCount).toBe(1)
    expect(res.councillors.find((c) => c.name === "beta")?.status).toBe("failed")
    expect(res.councillors.find((c) => c.name === "beta")?.error).toMatch(/provider down/)
  })

  it("treats an empty completion as a failed councillor", async () => {
    const perAlias = { fast: async () => ({ completion: "   " }) }
    const { deps } = makeDeps({ perAlias })
    const res = await runCouncil(baseOpts, deps)
    expect(res.councillors.find((c) => c.name === "alpha")?.status).toBe("failed")
    expect(res.councillors.find((c) => c.name === "alpha")?.error).toMatch(/empty response/)
  })

  it("times out a hung councillor", async () => {
    const perAlias = { fast: () => new Promise<{ completion: string }>(() => {}) }
    const { deps } = makeDeps({ perAlias })
    const res = await runCouncil({ ...baseOpts, timeoutMs: 20 }, deps)
    expect(res.councillors.find((c) => c.name === "alpha")?.status).toBe("failed")
    expect(res.councillors.find((c) => c.name === "alpha")?.error).toMatch(/timed out/)
  })

  it("appends extra synthesis guidance to the system prompt", async () => {
    const { deps, calls } = makeDeps()
    await runCouncil({ ...baseOpts, synthesisInstructions: "Be terse." }, deps)
    const synthCall = calls.find((c) => c.systemPrompt)
    expect(synthCall?.systemPrompt).toMatch(/Additional guidance:\nBe terse\./)
  })

  it("validates required input", async () => {
    const { deps } = makeDeps()
    await expect(runCouncil({ ...baseOpts, prompt: "  " }, deps)).rejects.toThrow(
      /prompt is required/
    )
    await expect(runCouncil({ ...baseOpts, councillors: [] }, deps)).rejects.toThrow(
      /at least one councillor/
    )
    await expect(runCouncil({ ...baseOpts, synthesizerAlias: "" }, deps)).rejects.toThrow(
      /synthesizerAlias/
    )
  })
})

describe("formatting helpers", () => {
  it("formatCouncillorPrompt prepends role guidance only when present", () => {
    expect(formatCouncillorPrompt("Q")).toBe("Q")
    expect(formatCouncillorPrompt("Q", "Role")).toBe("Role\n\n---\n\nQ")
  })

  it("formatCouncillorResults includes completed and failed councillors", () => {
    const out = formatCouncillorResults("Q", [
      { name: "a", model: "m1", status: "completed", text: "ans" },
      { name: "b", model: "m2", status: "failed", error: "boom" },
    ])
    expect(out).toMatch(/\*\*a\*\* \(m1\):\nans/)
    expect(out).toMatch(/Failed\/Timed-out Councillors/)
    expect(out).toMatch(/\*\*b\*\*: failed — boom/)
  })

  it("formatCouncillorResults handles the all-failed case", () => {
    const out = formatCouncillorResults("Q", [
      { name: "a", model: "m", status: "failed", error: "x" },
    ])
    expect(out).toMatch(/All councillors failed/)
    expect(out).toMatch(/Answer the original prompt directly/)
  })

  it("parseConfidence extracts the rating or returns unknown", () => {
    expect(parseConfidence("Confidence: unanimous")).toBe("unanimous")
    expect(parseConfidence("... confidence rating: SPLIT.")).toBe("split")
    expect(parseConfidence("no rating here")).toBe("unknown")
  })

  it("renderCouncilReport appends a footer with counts and confidence", () => {
    const report = renderCouncilReport({
      markdown: "## Council Response\nX",
      confidence: "majority",
      councillors: [],
      respondedCount: 2,
      totalCount: 3,
      synthesizerModel: "gpt",
    })
    expect(report).toMatch(/2\/3 councillors responded/)
    expect(report).toMatch(/synthesized by gpt/)
    expect(report).toMatch(/majority/)
  })
})
