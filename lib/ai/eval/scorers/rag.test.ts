import type { LlmClient } from "@/lib/twin/distill/llm"
import type { EvalCase, EvalRetrievedChunk, EvalSample } from "@/types/eval/eval"
import { makeRagScorer } from "./rag"

function sample(output: string, chunks: EvalRetrievedChunk[] = []): EvalSample {
  return {
    output,
    toolCalls: [],
    retrievedChunks: chunks,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    latencyMs: 0,
    stepCount: 0,
    degraded: false,
  }
}

function makeCase(reference?: EvalCase["reference"]): EvalCase {
  return {
    id: "c1",
    datasetId: "d1",
    input: "what is the capital of france?",
    capability: "chat.rag",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
    ...(reference ? { reference } : {}),
  }
}

function client(text: string): LlmClient {
  return {
    async complete() {
      return text
    },
  }
}

describe("makeRagScorer — faithfulness", () => {
  it("requires an LLM and the rag dimension", () => {
    const s = makeRagScorer({ metric: "faithfulness", client: client("{}") })
    expect(s.requiresLlm).toBe(true)
    expect(s.dimension).toBe("rag")
  })

  it("scores the fraction of answer statements supported by context", async () => {
    const s = makeRagScorer({
      metric: "faithfulness",
      client: client(
        '{"statements":[{"text":"a","supported":true},{"text":"b","supported":false}]}'
      ),
    })
    const score = await s.score(sample("answer", [{ text: "ctx" }]), makeCase())
    expect(score.value).toBe(0.5)
  })

  it("is not-applicable when nothing was retrieved", async () => {
    const s = makeRagScorer({ metric: "faithfulness", client: client("{}") })
    const score = await s.score(sample("answer", []), makeCase())
    expect(score.error).toBeDefined()
  })

  it("fails open on non-JSON judge output", async () => {
    const s = makeRagScorer({ metric: "faithfulness", client: client("not json") })
    const score = await s.score(sample("answer", [{ text: "ctx" }]), makeCase())
    expect(score.error).toBeDefined()
    expect(score.passed).toBe(false)
  })

  it("scores 1 when the answer has no statements to verify", async () => {
    const s = makeRagScorer({ metric: "faithfulness", client: client('{"statements":[]}') })
    const score = await s.score(sample("", [{ text: "ctx" }]), makeCase())
    expect(score.value).toBe(1)
    expect(score.passed).toBe(true)
  })

  it("fails open when the client throws", async () => {
    const throwing = {
      async complete() {
        throw new Error("provider down")
      },
    }
    const s = makeRagScorer({ metric: "faithfulness", client: throwing })
    const score = await s.score(sample("a", [{ text: "ctx" }]), makeCase())
    expect(score.error).toContain("provider down")
  })

  it("requires a client for the LLM metrics", async () => {
    const s = makeRagScorer({ metric: "faithfulness" })
    expect((await s.score(sample("a", [{ text: "c" }]), makeCase())).error).toContain(
      "requires an LLM"
    )
  })
})

describe("makeRagScorer — context-precision", () => {
  it("scores the fraction of retrieved chunks judged relevant", async () => {
    const s = makeRagScorer({
      metric: "context-precision",
      client: client('{"verdicts":[true,false,true]}'),
    })
    const score = await s.score(
      sample("answer", [{ text: "a" }, { text: "b" }, { text: "c" }]),
      makeCase()
    )
    expect(score.value).toBeCloseTo(2 / 3, 5)
  })

  it("is not-applicable when nothing was retrieved", async () => {
    const s = makeRagScorer({ metric: "context-precision", client: client("{}") })
    expect((await s.score(sample("answer", []), makeCase())).error).toBeDefined()
  })

  it("errors on empty verdicts", async () => {
    const s = makeRagScorer({ metric: "context-precision", client: client('{"verdicts":[]}') })
    expect((await s.score(sample("a", [{ text: "c" }]), makeCase())).error).toContain(
      "empty verdicts"
    )
  })
})

describe("makeRagScorer — answer-relevancy edge", () => {
  it("errors when the relevancy number is missing", async () => {
    const s = makeRagScorer({ metric: "answer-relevancy", client: client('{"foo":1}') })
    expect((await s.score(sample("a"), makeCase())).error).toContain("missing relevancy")
  })
})

describe("makeRagScorer — answer-relevancy", () => {
  it("uses the judged relevancy value and passes above threshold", async () => {
    const s = makeRagScorer({ metric: "answer-relevancy", client: client('{"relevancy":0.9}') })
    const score = await s.score(sample("paris", [{ text: "ctx" }]), makeCase())
    expect(score.value).toBe(0.9)
    expect(score.passed).toBe(true)
  })

  it("fails below the default 0.7 threshold", async () => {
    const s = makeRagScorer({ metric: "answer-relevancy", client: client('{"relevancy":0.4}') })
    expect((await s.score(sample("nonsense"), makeCase())).passed).toBe(false)
  })
})

describe("makeRagScorer — context-recall (deterministic)", () => {
  it("does not require an LLM", () => {
    const s = makeRagScorer({ metric: "context-recall" })
    expect(s.requiresLlm).toBe(false)
  })

  it("scores the fraction of expected context found in retrieved chunks", async () => {
    const s = makeRagScorer({ metric: "context-recall" })
    const c = makeCase({ expectedContext: ["Paris is the capital", "Eiffel Tower"] })
    const score = await s.score(
      sample("answer", [{ text: "Indeed, Paris is the capital of France." }]),
      c
    )
    expect(score.value).toBe(0.5)
  })

  it("is not-applicable without an expectedContext reference", async () => {
    const s = makeRagScorer({ metric: "context-recall" })
    const score = await s.score(sample("answer", [{ text: "x" }]), makeCase())
    expect(score.status).toBe("not-applicable")
    expect(score.error).toBeDefined()
  })
})

describe("makeRagScorer — status separation", () => {
  const chunks = [{ text: "Paris is the capital of France." }]

  it("reports a provider failure as errored, never as not-applicable", async () => {
    // The two must not look alike: "no RAG references in this dataset" and
    // "the judge provider is down" call for completely different reactions.
    const s = makeRagScorer({
      metric: "faithfulness",
      client: {
        complete: async () => {
          throw new Error("upstream 503")
        },
      },
    })
    const score = await s.score(sample("answer", chunks), makeCase())
    expect(score.status).toBe("errored")
    expect(score.error).toBe("upstream 503")
  })

  it("stringifies a non-Error rejection", async () => {
    const s = makeRagScorer({
      metric: "answer-relevancy",
      client: {
        complete: async () => {
          throw "rate limited"
        },
      },
    })
    const score = await s.score(sample("answer", chunks), makeCase())
    expect(score.status).toBe("errored")
    expect(score.error).toBe("rate limited")
  })

  it("reports a malformed judge payload as errored", async () => {
    const s = makeRagScorer({
      metric: "context-precision",
      client: { complete: async () => "not json at all" } as LlmClient,
    })
    const score = await s.score(sample("answer", chunks), makeCase())
    expect(score.status).toBe("errored")
    expect(score.error).toContain("rag parse error")
  })

  it("reports no-retrieval as not-applicable for the LLM metrics", async () => {
    const s = makeRagScorer({
      metric: "faithfulness",
      client: { complete: async () => "{}" } as LlmClient,
    })
    const score = await s.score(sample("answer"), makeCase())
    expect(score.status).toBe("not-applicable")
  })
})
