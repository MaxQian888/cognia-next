import { executeAiCouncil, type AiCouncilParams } from "./ai-council"
import type { RunCouncilDeps } from "@/lib/ai/council/run-council"
import type { StepExecutionContext } from "@/types/workflow/visual"

const COUNCIL_SYS_HEAD = "You are the Council synthesizer"

function makeCtx(params: AiCouncilParams) {
  const streamed: string[] = []
  const logs: Array<{ level: string; message: string }> = []
  const ctx = {
    runId: "run1",
    stepId: "step1",
    params,
    signal: new AbortController().signal,
    log: (level: string, message: string) => logs.push({ level, message }),
    emitStream: (delta: string) => streamed.push(delta),
  } as unknown as StepExecutionContext
  return { ctx, streamed, logs }
}

/** Deps factory: councillors echo their alias; synthesizer returns a report. */
function fakeDepsFactory(): () => Promise<RunCouncilDeps> {
  return async () => ({
    runPrompt: async (input) => {
      if (input.systemPrompt?.startsWith(COUNCIL_SYS_HEAD)) {
        return {
          completion: "## Council Response\nDo X\n## Council Summary\nConfidence: unanimous",
          model: "synth",
        }
      }
      return { completion: `from ${input.modelAlias}`, model: input.modelAlias }
    },
  })
}

const baseParams: AiCouncilParams = {
  prompt: "Queue or outbox?",
  councillors: [
    { name: "alpha", modelAlias: "fast" },
    { name: "beta", modelAlias: "smart" },
  ],
  synthesizerAlias: "synth",
}

describe("executeAiCouncil", () => {
  it("runs the council and returns the structured result", async () => {
    const { ctx, streamed } = makeCtx(baseParams)
    const res = await executeAiCouncil(ctx, fakeDepsFactory())
    const out = res.output as {
      markdown: string
      confidence: string
      respondedCount: number
      totalCount: number
    }
    expect(out.totalCount).toBe(2)
    expect(out.respondedCount).toBe(2)
    expect(out.confidence).toBe("unanimous")
    expect(out.markdown).toMatch(/Council Response/)
    // The report is emitted to the run stream.
    expect(streamed.join("")).toMatch(/Council Response/)
  })

  it("throws (non-retryable) when no councillors are provided", async () => {
    const { ctx } = makeCtx({ ...baseParams, councillors: [] })
    await expect(executeAiCouncil(ctx, fakeDepsFactory())).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("throws when the synthesizer alias is missing", async () => {
    const { ctx } = makeCtx({ ...baseParams, synthesizerAlias: undefined })
    await expect(executeAiCouncil(ctx, fakeDepsFactory())).rejects.toThrow(/synthesizerAlias/)
  })

  it("throws when the prompt is empty", async () => {
    const { ctx } = makeCtx({ ...baseParams, prompt: "   " })
    await expect(executeAiCouncil(ctx, fakeDepsFactory())).rejects.toThrow(/non-empty prompt/)
  })

  it("ignores malformed councillor entries", async () => {
    const { ctx } = makeCtx({
      ...baseParams,
      councillors: [{ name: "ok", modelAlias: "fast" }, { name: "bad" } as never, null as never],
    })
    const res = await executeAiCouncil(ctx, fakeDepsFactory())
    expect((res.output as { totalCount: number }).totalCount).toBe(1)
  })

  it("redacts PII in the prompt under redact mode and flags it", async () => {
    const { ctx } = makeCtx({
      ...baseParams,
      prompt: "Email me at jane@example.com",
      piiGate: "redact",
    })
    const res = await executeAiCouncil(ctx, fakeDepsFactory())
    expect((res.output as { piiRedacted?: boolean }).piiRedacted).toBe(true)
  })

  it("blocks the step when block mode sees PII", async () => {
    const { ctx } = makeCtx({
      ...baseParams,
      prompt: "ssn 123-45-6789 email a@b.com",
      piiGate: "block",
    })
    await expect(executeAiCouncil(ctx, fakeDepsFactory())).rejects.toMatchObject({
      retryable: false,
    })
  })
})
