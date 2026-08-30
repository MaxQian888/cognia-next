import type { EvalCase, EvalSample } from "../domain/eval"
import type { GradingSpec } from "../domain/grading"
import { GSM8K_ANSWER_PATTERN } from "../domain/grading"
import {
  choiceMatchScorer,
  containsAnyScorer,
  exactMatchScorer,
  extractChoice,
  extractNumber,
  matchScorers,
  normalizeAnswer,
  numericMatchScorer,
  regexMatchScorer,
} from "./match"

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

function makeCase(reference?: EvalCase["reference"]): EvalCase {
  return {
    id: "c1",
    datasetId: "d1",
    input: "q",
    capability: "chat.qa",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
    ...(reference ? { reference } : {}),
  }
}

const withGrading = (grading: GradingSpec, rest: EvalCase["reference"] = {}) =>
  makeCase({ ...rest, grading })

describe("normalizeAnswer", () => {
  it("lowercases and collapses whitespace by default", () => {
    expect(normalizeAnswer("  The   ANSWER \n is  42 ")).toBe("the answer is 42")
  })

  it("keeps case when asked", () => {
    expect(normalizeAnswer("Paris", { caseInsensitive: false })).toBe("Paris")
  })

  it("strips punctuation including full-width CJK marks", () => {
    expect(normalizeAnswer("巴黎，是首都。", { stripPunctuation: true })).toBe("巴黎 是首都")
  })

  it("strips English articles only when asked", () => {
    expect(normalizeAnswer("the Eiffel Tower")).toBe("the eiffel tower")
    expect(normalizeAnswer("the Eiffel Tower", { stripArticles: true })).toBe("eiffel tower")
  })
})

describe("extractNumber", () => {
  it("takes the LAST number when no pattern is given (models conclude at the end)", () => {
    expect(extractNumber("She had 5, then bought 3 more, so 8 in total.")).toBe(8)
  })

  it("honours a capture group so GSM8K's marked answer wins over the reasoning", () => {
    const gold = "Janet sells 9 eggs at $2 each.\n9 * 2 = 18\n#### 18"
    expect(extractNumber(gold, GSM8K_ANSWER_PATTERN)).toBe(18)
  })

  it("drops thousands separators", () => {
    expect(extractNumber("#### 1,234", GSM8K_ANSWER_PATTERN)).toBe(1234)
    expect(extractNumber("the total is 1,048,576")).toBe(1048576)
  })

  it("ignores a sentence-final period but keeps a real decimal point", () => {
    expect(extractNumber("The answer is 42.")).toBe(42)
    expect(extractNumber("The answer is 3.14")).toBeCloseTo(3.14, 5)
  })

  it("handles negatives", () => {
    expect(extractNumber("a change of -7 degrees")).toBe(-7)
  })

  it("returns null when there is no number, or the pattern misses", () => {
    expect(extractNumber("no digits here")).toBeNull()
    expect(extractNumber("42 but unmarked", GSM8K_ANSWER_PATTERN)).toBeNull()
  })

  it("returns null on an invalid pattern rather than throwing", () => {
    expect(extractNumber("#### 5", "([unclosed")).toBeNull()
  })
})

describe("extractChoice", () => {
  it("accepts a bare letter", () => {
    expect(extractChoice("B")).toBe("B")
    expect(extractChoice(" c ")).toBe("C")
  })

  it("accepts a 1-based ordinal, as datasets that store option indexes use", () => {
    expect(extractChoice("2")).toBe("B")
    expect(extractChoice("1")).toBe("A")
  })

  it("finds a decorated letter inside prose, preferring the model's conclusion", () => {
    expect(extractChoice("Option A is wrong because … therefore the answer is (C).")).toBe("C")
    expect(extractChoice("**B**")).toBe("B")
    expect(extractChoice("Answer: D.")).toBe("D")
  })

  it("respects a custom alphabet", () => {
    expect(extractChoice("E", "ABCD")).toBeNull()
    expect(extractChoice("4", "ABCD")).toBe("D")
  })

  it("returns null when nothing looks like a choice", () => {
    expect(extractChoice("")).toBeNull()
    expect(extractChoice("none of these")).toBeNull()
  })
})

describe("match scorers — applicability", () => {
  it("all report not-applicable when the case declares no grading rule", async () => {
    for (const scorer of matchScorers) {
      const score = await scorer.score(sample("42"), makeCase({ expectedOutput: "42" }))
      expect(score.status).toBe("not-applicable")
    }
  })

  it("only the scorer matching the declared mode produces a verdict", async () => {
    const c = withGrading({ mode: "exact" }, { expectedOutput: "paris" })
    const statuses = await Promise.all(
      matchScorers.map(async (s) => [s.id, (await s.score(sample("Paris"), c)).status] as const)
    )
    expect(Object.fromEntries(statuses)).toEqual({
      "exact-match": "scored",
      "contains-any": "not-applicable",
      "regex-match": "not-applicable",
      "numeric-match": "not-applicable",
      "choice-match": "not-applicable",
    })
  })

  it("is not-applicable when the declared mode has no reference to work with", async () => {
    expect((await exactMatchScorer.score(sample("x"), withGrading({ mode: "exact" }))).status).toBe(
      "not-applicable"
    )
    expect(
      (await containsAnyScorer.score(sample("x"), withGrading({ mode: "contains-any" }))).status
    ).toBe("not-applicable")
    expect((await regexMatchScorer.score(sample("x"), withGrading({ mode: "regex" }))).status).toBe(
      "not-applicable"
    )
  })

  it("all are deterministic, gating, response-quality scorers", () => {
    for (const s of matchScorers) {
      expect(s.requiresLlm).toBe(false)
      expect(s.gating).toBe(true)
      expect(s.dimension).toBe("response-quality")
    }
  })
})

describe("exact-match", () => {
  it("passes on a normalized match", async () => {
    const c = withGrading({ mode: "exact" }, { expectedOutput: "  Paris " })
    expect((await exactMatchScorer.score(sample("paris"), c)).passed).toBe(true)
  })

  it("fails on a different answer", async () => {
    const c = withGrading({ mode: "exact" }, { expectedOutput: "Paris" })
    expect((await exactMatchScorer.score(sample("Lyon"), c)).passed).toBe(false)
  })

  it("honours the normalize options", async () => {
    const strict = withGrading(
      { mode: "exact", normalize: { caseInsensitive: false } },
      { expectedOutput: "Paris" }
    )
    expect((await exactMatchScorer.score(sample("paris"), strict)).passed).toBe(false)

    const loose = withGrading(
      { mode: "exact", normalize: { stripPunctuation: true, stripArticles: true } },
      { expectedOutput: "the Eiffel Tower!" }
    )
    expect((await exactMatchScorer.score(sample("Eiffel Tower"), loose)).passed).toBe(true)
  })
})

describe("contains-any", () => {
  it("passes when ANY alias appears — unlike `assertion`, which needs them all", async () => {
    const c = withGrading(
      { mode: "contains-any" },
      { expectedContains: ["JFK", "John F. Kennedy", "Kennedy"] }
    )
    const score = await containsAnyScorer.score(sample("It was John F. Kennedy."), c)
    expect(score.passed).toBe(true)
    expect(score.metadata).toMatchObject({ total: 3 })
  })

  it("fails when no alias appears", async () => {
    const c = withGrading({ mode: "contains-any" }, { expectedContains: ["JFK", "Kennedy"] })
    expect((await containsAnyScorer.score(sample("It was Nixon."), c)).passed).toBe(false)
  })
})

describe("regex-match", () => {
  it("passes when the pattern matches, case-insensitively", async () => {
    const c = withGrading({ mode: "regex", pattern: "^\\s*yes\\b" })
    expect((await regexMatchScorer.score(sample("Yes, it does."), c)).passed).toBe(true)
    expect((await regexMatchScorer.score(sample("No."), c)).passed).toBe(false)
  })

  it("is not-applicable on an invalid pattern instead of crashing the run", async () => {
    const c = withGrading({ mode: "regex", pattern: "([unclosed" })
    const score = await regexMatchScorer.score(sample("x"), c)
    expect(score.status).toBe("not-applicable")
    expect(score.error).toContain("invalid grading.pattern")
  })
})

describe("numeric-match", () => {
  const gsm8k = (gold: string) =>
    withGrading({ mode: "numeric", pattern: GSM8K_ANSWER_PATTERN }, { expectedOutput: gold })

  it("grades a GSM8K item through the model's chain of thought", async () => {
    const c = gsm8k("Janet has 16 eggs, eats 3, bakes 4.\n16-3-4=9\n#### 18")
    const answer = "She eats 3 and bakes 4, leaving 9 to sell at $2 each, so she makes 18 dollars."
    expect((await numericMatchScorer.score(sample(answer), c)).passed).toBe(true)
  })

  it("fails when the model's final number is wrong", async () => {
    const c = gsm8k("#### 18")
    expect((await numericMatchScorer.score(sample("… so the total is 20."), c)).passed).toBe(false)
  })

  it("compares exactly by default and within an explicit tolerance", async () => {
    const exact = withGrading({ mode: "numeric" }, { expectedOutput: "3.14159" })
    expect((await numericMatchScorer.score(sample("3.14"), exact)).passed).toBe(false)

    const loose = withGrading({ mode: "numeric", tolerance: 0.01 }, { expectedOutput: "3.14159" })
    expect((await numericMatchScorer.score(sample("3.14"), loose)).passed).toBe(true)
  })

  it("fails (not errors) when the answer contains no number at all", async () => {
    const c = gsm8k("#### 18")
    const score = await numericMatchScorer.score(sample("I cannot solve this."), c)
    expect(score.status).toBe("scored")
    expect(score.passed).toBe(false)
    expect(score.metadata).toMatchObject({ actual: null })
  })

  it("is not-applicable when the GOLD answer has no extractable number", async () => {
    const c = gsm8k("no marker here")
    expect((await numericMatchScorer.score(sample("18"), c)).status).toBe("not-applicable")
  })
})

describe("choice-match", () => {
  it("grades an MMLU-style item where the model wraps its letter in prose", async () => {
    const c = withGrading({ mode: "choice" }, { expectedOutput: "B" })
    expect((await choiceMatchScorer.score(sample("The answer is (B)."), c)).passed).toBe(true)
    expect((await choiceMatchScorer.score(sample("I'd go with C."), c)).passed).toBe(false)
  })

  it("accepts a gold answer stored as a 1-based index", async () => {
    const c = withGrading({ mode: "choice" }, { expectedOutput: "2" })
    expect((await choiceMatchScorer.score(sample("B"), c)).passed).toBe(true)
  })

  it("fails when the model never states a choice", async () => {
    const c = withGrading({ mode: "choice" }, { expectedOutput: "B" })
    const score = await choiceMatchScorer.score(sample("It depends."), c)
    expect(score.passed).toBe(false)
    expect(score.metadata).toMatchObject({ expected: "B", actual: null })
  })

  it("is not-applicable when the gold answer is not a choice", async () => {
    const c = withGrading({ mode: "choice" }, { expectedOutput: "the capital of France" })
    expect((await choiceMatchScorer.score(sample("A"), c)).status).toBe("not-applicable")
  })

  it("respects a restricted alphabet", async () => {
    const c = withGrading({ mode: "choice", alphabet: "ABCD" }, { expectedOutput: "D" })
    expect((await choiceMatchScorer.score(sample("4"), c)).passed).toBe(true)
  })
})
