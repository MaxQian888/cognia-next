import {
  CODE_MODE_LIMITS,
  CodeCallBudget,
  byteLength,
  checkResultSize,
  checkSourceSize,
} from "./limits"
import sidecarLimits from "./limits.json"

describe("CODE_MODE_LIMITS", () => {
  it("matches the first-release figures from the ADR", () => {
    expect(CODE_MODE_LIMITS).toEqual({
      maxSourceBytes: 32 * 1024,
      wallTimeMs: 30_000,
      maxToolCalls: 64,
      maxConcurrency: 8,
      maxResultBytes: 1024 * 1024,
      maxMemoryBytes: 256 * 1024 * 1024,
    })
  })

  // The sandbox supervisor is a sidecar .mjs that reads the JSON directly; if
  // these ever diverge the enforced ceiling and the advertised one disagree.
  it("is exactly the JSON the sidecar supervisor reads", () => {
    expect(CODE_MODE_LIMITS).toEqual(sidecarLimits)
  })
})

describe("byteLength", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(byteLength("abc")).toBe(3)
    // A source-size check based on `.length` would let a program of multibyte
    // text through at up to three times the intended ceiling.
    expect(byteLength("中文")).toBe(6)
    expect(byteLength("😀")).toBe(4)
  })
})

describe("checkSourceSize", () => {
  it("passes a program under the ceiling", () => {
    expect(checkSourceSize("return 1")).toBeNull()
  })

  it("rejects a program over the ceiling with the observed size", () => {
    const source = "x".repeat(CODE_MODE_LIMITS.maxSourceBytes + 1)
    expect(checkSourceSize(source)).toEqual({
      kind: "source-too-large",
      limit: CODE_MODE_LIMITS.maxSourceBytes,
      observed: CODE_MODE_LIMITS.maxSourceBytes + 1,
    })
  })

  it("accepts a program exactly at the ceiling", () => {
    expect(checkSourceSize("x".repeat(CODE_MODE_LIMITS.maxSourceBytes))).toBeNull()
  })

  it("honours an injected limit", () => {
    expect(checkSourceSize("abcde", { ...CODE_MODE_LIMITS, maxSourceBytes: 4 })?.kind).toBe(
      "source-too-large"
    )
  })
})

describe("checkResultSize", () => {
  it("passes a small result", () => {
    expect(checkResultSize('{"a":1}')).toBeNull()
  })

  it("rejects an oversized result", () => {
    const big = "x".repeat(CODE_MODE_LIMITS.maxResultBytes + 1)
    expect(checkResultSize(big)?.kind).toBe("result-too-large")
  })
})

describe("CodeCallBudget", () => {
  it("starts with the full budget", () => {
    const budget = new CodeCallBudget()
    expect(budget.callsUsed).toBe(0)
    expect(budget.callsRemaining).toBe(CODE_MODE_LIMITS.maxToolCalls)
    expect(budget.concurrencyAvailable).toBe(CODE_MODE_LIMITS.maxConcurrency)
  })

  it("spends one slot per acquire", () => {
    const budget = new CodeCallBudget({ ...CODE_MODE_LIMITS, maxToolCalls: 2 })
    expect(budget.tryAcquire()).toEqual({ ok: true })
    budget.release()
    expect(budget.callsUsed).toBe(1)
    expect(budget.callsRemaining).toBe(1)
  })

  it("refuses once the total budget is spent", () => {
    const budget = new CodeCallBudget({ ...CODE_MODE_LIMITS, maxToolCalls: 1 })
    budget.tryAcquire()
    budget.release()
    expect(budget.tryAcquire()).toEqual({
      ok: false,
      exceeded: { kind: "tool-calls", limit: 1, observed: 2 },
    })
  })

  // Concurrency is backpressure, not a failure: an over-concurrent program is
  // told to wait, whereas an over-budget one is stopped.
  it("signals retry rather than failure when concurrency is saturated", () => {
    const budget = new CodeCallBudget({ ...CODE_MODE_LIMITS, maxConcurrency: 1 })
    expect(budget.tryAcquire()).toEqual({ ok: true })
    expect(budget.tryAcquire()).toEqual({ ok: false, retry: true })
    expect(budget.concurrencyAvailable).toBe(0)
  })

  it("frees a concurrency slot on release without refunding the budget", () => {
    const budget = new CodeCallBudget({ ...CODE_MODE_LIMITS, maxConcurrency: 1 })
    budget.tryAcquire()
    budget.release()
    expect(budget.concurrencyAvailable).toBe(1)
    expect(budget.callsUsed).toBe(1)
  })

  it("ignores an unbalanced release rather than going negative", () => {
    const budget = new CodeCallBudget()
    budget.release()
    budget.release()
    expect(budget.concurrencyAvailable).toBe(CODE_MODE_LIMITS.maxConcurrency)
    expect(budget.callsUsed).toBe(0)
  })
})
