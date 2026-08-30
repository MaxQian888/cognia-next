import type { EvalJudgeClient } from "./judge-client"
import type { EvalCase, EvalSample } from "../domain/eval"
import { makeJudgeScorer } from "./judge"

function sample(output: string): EvalSample {
  return {
    output,
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    latencyMs: 0,
    stepCount: 0,
    degraded: false,
  }
}

function makeCase(input = "summarize the file"): EvalCase {
  return {
    id: "c1",
    datasetId: "d1",
    input,
    capability: "chat.response",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
  }
}

function clientReturning(text: string, capture?: { prompt?: string }): EvalJudgeClient {
  return {
    async complete(prompt: string) {
      if (capture) capture.prompt = prompt
      return text
    },
  }
}

const RUBRIC = "Pass only if the answer fully addresses the user's request."

describe("makeJudgeScorer", () => {
  it("is flagged as requiring an LLM", () => {
    const scorer = makeJudgeScorer({
      client: clientReturning("{}"),
      criterion: "task completion",
      rubric: RUBRIC,
    })
    expect(scorer.requiresLlm).toBe(true)
    expect(scorer.dimension).toBe("response-quality")
  })

  it("passes (value 1) when the judge returns pass:true", async () => {
    const scorer = makeJudgeScorer({
      client: clientReturning('{"pass": true, "reasoning": "fully addressed"}'),
      criterion: "task completion",
      rubric: RUBRIC,
    })
    const score = await scorer.score(sample("here is the summary"), makeCase())
    expect(score.value).toBe(1)
    expect(score.passed).toBe(true)
    expect(score.reasoning).toBe("fully addressed")
  })

  it("fails (value 0) when the judge returns pass:false", async () => {
    const scorer = makeJudgeScorer({
      client: clientReturning('{"pass": false, "reasoning": "ignored the question"}'),
      criterion: "task completion",
      rubric: RUBRIC,
    })
    const score = await scorer.score(sample("unrelated"), makeCase())
    expect(score.value).toBe(0)
    expect(score.passed).toBe(false)
  })

  it("includes the criterion, the user request and the agent answer in the prompt", async () => {
    const capture: { prompt?: string } = {}
    const scorer = makeJudgeScorer({
      client: clientReturning('{"pass": true, "reasoning": "ok"}', capture),
      criterion: "task completion",
      rubric: RUBRIC,
    })
    await scorer.score(sample("THE-ANSWER"), makeCase("THE-REQUEST"))
    expect(capture.prompt).toContain("task completion")
    expect(capture.prompt).toContain("THE-REQUEST")
    expect(capture.prompt).toContain("THE-ANSWER")
  })

  it("fails open (errored score, no throw) when the judge response is not JSON", async () => {
    const scorer = makeJudgeScorer({
      client: clientReturning("I think it is fine, honestly"),
      criterion: "task completion",
      rubric: RUBRIC,
    })
    const score = await scorer.score(sample("x"), makeCase())
    expect(score.error).toBeDefined()
    expect(score.passed).toBe(false)
  })

  it("fails open when the client throws", async () => {
    const scorer = makeJudgeScorer({
      client: {
        async complete() {
          throw new Error("provider 500")
        },
      },
      criterion: "task completion",
      rubric: RUBRIC,
    })
    const score = await scorer.score(sample("x"), makeCase())
    expect(score.error).toContain("provider 500")
    expect(score.passed).toBe(false)
  })

  it("includes conversation history and a reference answer in the prompt", async () => {
    const capture: { prompt?: string } = {}
    const scorer = makeJudgeScorer({
      client: clientReturning('{"pass": true, "reasoning": "ok"}', capture),
      criterion: "task completion",
      rubric: RUBRIC,
    })
    const c: EvalCase = {
      ...makeCase("the question"),
      history: [{ role: "user", content: "EARLIER-TURN" }],
      reference: { expectedOutput: "GOLD-ANSWER" },
    }
    await scorer.score(sample("answer"), c)
    expect(capture.prompt).toContain("EARLIER-TURN")
    expect(capture.prompt).toContain("GOLD-ANSWER")
  })

  it("fails open when pass is missing or non-boolean", async () => {
    const scorer = makeJudgeScorer({
      client: clientReturning('{"reasoning": "no verdict field"}'),
      criterion: "task completion",
      rubric: RUBRIC,
    })
    const score = await scorer.score(sample("x"), makeCase())
    expect(score.status).toBe("errored")
    expect(score.error).toBeDefined()
  })

  it("marks a provider failure as errored, not as a failed verdict", async () => {
    // `errored` must stay distinct from a real `fail`: a dead judge is not
    // evidence the agent got it wrong, and the report counts them separately.
    const scorer = makeJudgeScorer({
      client: {
        complete: async () => {
          throw new Error("upstream 503")
        },
      },
      criterion: "task completion",
      rubric: RUBRIC,
    })
    const score = await scorer.score(sample("x"), makeCase())
    expect(score.status).toBe("errored")
    expect(score.error).toBe("upstream 503")
  })

  it("stringifies a non-Error rejection instead of crashing the run", async () => {
    const scorer = makeJudgeScorer({
      client: {
        complete: async () => {
          throw "rate limited"
        },
      },
      criterion: "task completion",
      rubric: RUBRIC,
    })
    const score = await scorer.score(sample("x"), makeCase())
    expect(score.status).toBe("errored")
    expect(score.error).toBe("rate limited")
  })

  it("scores without a reasoning field when the judge omits one", async () => {
    const scorer = makeJudgeScorer({
      client: clientReturning('{"pass": false}'),
      criterion: "task completion",
      rubric: RUBRIC,
    })
    const score = await scorer.score(sample("x"), makeCase())
    expect(score.status).toBe("scored")
    expect(score.passed).toBe(false)
    expect(score.reasoning).toBeUndefined()
  })
})
