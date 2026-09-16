import type { RateCard } from "../contracts/schemas"
import { UsageInconsistentError, normalizeUsage, priceUsage, toContractUsage } from "./normalize"
import { UsageSchema } from "../contracts/schemas"

const CARD: RateCard = {
  id: "rate-test-1",
  example_only: true,
  currency: "USD",
  ordinary_input_per_million: "1.00",
  output_per_million: "2.00",
  cache_read_per_million: "0.10",
  cache_write_5m_per_million: "1.25",
  cache_write_1h_per_million: "2.00",
}

const OPENAI = {
  inputIncludesCacheRead: true,
  inputIncludesCacheWrite: false,
  outputIncludesReasoning: true,
}
const ANTHROPIC = {
  inputIncludesCacheRead: false,
  inputIncludesCacheWrite: false,
  outputIncludesReasoning: true,
}

describe("usage normalization", () => {
  it("[ACC:BUD-04] does not add cached tokens twice when the prompt total already contains them", () => {
    const usage = normalizeUsage(
      { inputTokens: 1000, cacheReadTokens: 600, outputTokens: 10 },
      OPENAI
    )
    expect(usage.input_uncached_tokens).toBe(400)
    expect(usage.input_cache_read_tokens).toBe(600)
    expect(usage.input_uncached_tokens + usage.input_cache_read_tokens).toBe(1000)
    const priced = priceUsage(usage, CARD)
    // 400 × $1/M + 600 × $0.10/M + 10 × $2/M = 400 + 60 + 20 microusd
    expect(priced.total_microusd).toBe(480)
  })

  it("adds cache buckets beside an exclusive Anthropic-style input total", () => {
    const usage = normalizeUsage(
      {
        inputTokens: 100,
        cacheReadTokens: 900,
        cacheWrite5mTokens: 200,
        cacheWrite1hTokens: 100,
        outputTokens: 50,
      },
      ANTHROPIC
    )
    expect(usage).toMatchObject({
      input_uncached_tokens: 100,
      input_cache_read_tokens: 900,
      input_cache_write_5m_tokens: 200,
      input_cache_write_1h_tokens: 100,
    })
    const kinds = priceUsage(usage, CARD).items.map((item) => [item.kind, item.amount_microusd])
    expect(kinds).toEqual([
      ["ordinary_input", 100],
      ["cache_read", 90],
      ["cache_write_5m", 250],
      ["cache_write_1h", 200],
      ["output", 100],
    ])
  })

  it("[ACC:BUD-05] bills reasoning once when it is already inside output, and keeps it for diagnostics", () => {
    const included = normalizeUsage(
      { inputTokens: 0, outputTokens: 1000, reasoningTokens: 800 },
      OPENAI
    )
    const pricedIncluded = priceUsage(included, CARD)
    expect(pricedIncluded.total_microusd).toBe(2000)
    expect(pricedIncluded.items.map((i) => i.kind)).toEqual(["output"])
    expect(included.reasoning_tokens).toBe(800)

    const separate = normalizeUsage(
      { inputTokens: 0, outputTokens: 200, reasoningTokens: 800 },
      { ...OPENAI, outputIncludesReasoning: false }
    )
    const pricedSeparate = priceUsage(separate, CARD)
    expect(pricedSeparate.items.map((i) => [i.kind, i.amount_microusd])).toEqual([
      ["output", 400],
      ["reasoning_separate", 1600],
    ])
  })

  it("prices a flat cache-write total at the 5m rate when no TTL split is reported", () => {
    const usage = normalizeUsage(
      { inputTokens: 0, cacheWriteTokens: 400, outputTokens: 0 },
      ANTHROPIC
    )
    expect(usage.input_cache_write_5m_tokens).toBe(400)
    expect(usage.input_cache_write_1h_tokens).toBe(0)
  })

  it("subtracts included cache writes from the input total", () => {
    const usage = normalizeUsage(
      { inputTokens: 1000, cacheWriteTokens: 300, cacheReadTokens: 100, outputTokens: 0 },
      { inputIncludesCacheRead: true, inputIncludesCacheWrite: true, outputIncludesReasoning: true }
    )
    expect(usage.input_uncached_tokens).toBe(600)
  })

  it("refuses reports that contradict their declared semantics instead of clamping", () => {
    expect(() =>
      normalizeUsage({ inputTokens: 10, cacheReadTokens: 11, outputTokens: 0 }, OPENAI)
    ).toThrow(UsageInconsistentError)
    expect(() =>
      normalizeUsage({ inputTokens: 0, outputTokens: 5, reasoningTokens: 6 }, OPENAI)
    ).toThrow(UsageInconsistentError)
    expect(() =>
      normalizeUsage(
        { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 5, cacheWrite5mTokens: 1 },
        ANTHROPIC
      )
    ).toThrow(UsageInconsistentError)
    expect(() =>
      normalizeUsage(
        { inputTokens: 5, outputTokens: 0, cacheWriteTokens: 6 },
        { ...ANTHROPIC, inputIncludesCacheWrite: true }
      )
    ).toThrow(UsageInconsistentError)
    expect(() => normalizeUsage({ inputTokens: -1, outputTokens: 0 }, OPENAI)).toThrow(
      UsageInconsistentError
    )
  })

  it("prices per-call tools and refuses a per-call charge without a price", () => {
    const usage = normalizeUsage(
      { inputTokens: 0, outputTokens: 0, perCall: { web_search: 2, request: 1, zero: 0 } },
      OPENAI
    )
    expect(usage.per_call).toEqual({ web_search: 2, request: 1 })
    const priced = priceUsage(usage, CARD, { web_search: "0.01", request: "0.001" })
    expect(priced.items.map((i) => [i.kind, i.amount_microusd])).toEqual([
      ["tool", 20000],
      ["request", 1000],
    ])
    expect(() => priceUsage(usage, CARD, { web_search: "0.01" })).toThrow(UsageInconsistentError)
  })

  it("produces a contract-valid Usage object", () => {
    const usage = normalizeUsage(
      { inputTokens: 100, cacheReadTokens: 20, outputTokens: 30 },
      OPENAI
    )
    const contract = toContractUsage(usage, priceUsage(usage, CARD), "actual", null)
    expect(UsageSchema.parse(contract)).toEqual(contract)
    expect(contract.input_uncached_tokens).toBe(80)
  })
})
