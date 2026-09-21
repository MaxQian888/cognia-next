import type { ObservedCall } from "./observed-executor"
import {
  addUsage,
  answerPreview,
  callRecordsOf,
  capabilityMatrix,
  disclaimerFor,
  emptyUsage,
  LIVE_SMOKE_REPORT_SCHEMA,
  liveSmokeExitCode,
  renderLiveSmokeMarkdown,
  SIMULATED_DISCLAIMER,
  summarizeRetries,
  totalSpent,
  usageBucketsOf,
  type AttemptLike,
  type LiveCaseReport,
  type LiveSmokeReport,
} from "./report"

const NORMALIZED = {
  input_uncached_tokens: 100,
  input_cache_read_tokens: 20,
  input_cache_write_5m_tokens: 5,
  input_cache_write_1h_tokens: 0,
  output_tokens: 40,
  reasoning_tokens: 12,
  reasoning_included_in_output: true,
  per_call: {},
  diagnostics: { reported_input_tokens: 125, reported_output_tokens: 40 },
}

function attempt(overrides: Partial<AttemptLike> = {}): AttemptLike {
  return {
    attemptId: "a1",
    logicalStepId: "direct:solver",
    attemptNo: 1,
    role: "solver",
    deploymentId: "openai::gpt-4o",
    state: "SUCCEEDED",
    providerRequestId: "req_1",
    actualMicrousd: 1_234,
    costStatus: "actual",
    errorClass: null,
    usage: NORMALIZED,
    ...overrides,
  }
}

function observed(overrides: Partial<ObservedCall> = {}): ObservedCall {
  return {
    runId: "run-1",
    logicalStepId: "direct:solver",
    attemptId: "a1",
    role: "solver",
    deploymentId: "openai::gpt-4o",
    startedAt: 0,
    latencyMs: 321,
    outcome: "ok",
    errorClass: null,
    retryAfterMs: null,
    providerRequestId: "req_1",
    finishReason: "stop",
    usage: { inputTokens: 125, outputTokens: 40 },
    ...overrides,
  }
}

function caseReport(overrides: Partial<LiveCaseReport> = {}): LiveCaseReport {
  const { calls } = callRecordsOf([attempt()], [observed()])
  return {
    id: "direct",
    mode: "direct",
    title: "Direct",
    outcome: "succeeded",
    detail: "direct run sealed, quality accepted",
    runId: "run-1",
    capMicrousd: 400_000,
    spentMicrousd: 1_234,
    overspendMicrousd: 0,
    modelCalls: 1,
    costStatus: "actual",
    route: {
      actionId: "direct_baseline",
      ruleId: "R1_explicit_mode",
      roles: { solver: "openai::gpt-4o" },
      reserveMicrousd: 80_000,
      reasonCodes: [],
    },
    reasons: [],
    result: {
      qualityStatus: "accepted",
      verificationStatus: "passed",
      warnings: [],
      answerChars: 10,
      answerPreview: "an | answer",
    },
    error: null,
    calls,
    usage: calls.reduce((total, call) => addUsage(total, call.usage), emptyUsage()),
    retry: summarizeRetries(calls, { executorCalls: 1, unledgeredCalls: 0, httpRequests: 1 }),
    events: { "run.completed": 1 },
    effects: { usage_row: 1 },
    durationMs: 900,
    ...overrides,
  }
}

function report(overrides: Partial<LiveSmokeReport> = {}): LiveSmokeReport {
  const cases = [caseReport()]
  return {
    schema: LIVE_SMOKE_REPORT_SCHEMA,
    version: 1,
    label: "simulated",
    generatedAt: "2026-09-19T00:00:00.000Z",
    disclaimer: disclaimerFor("simulated"),
    budgetMode: "strict",
    totalCapMicrousd: 5_000_000,
    plannedMicrousd: 4_800_000,
    totalSpentMicrousd: 1_234,
    remainingMicrousd: 4_998_766,
    capEnforcement: { ledgerProbe: "refused_over_cap", rule: "rule" },
    providers: [
      {
        id: "openai",
        name: "openai",
        kind: "builtin",
        enabled: true,
        credentialEnv: "COGNIA_LIVE_SMOKE_KEY_OPENAI",
        credentialFound: true,
        selected: true,
      },
    ],
    fixtureRoot: "/tmp/fixture",
    network: { mode: "blocked", requests: 0, blocked: 0 },
    cases,
    capabilities: capabilityMatrix(cases),
    ...overrides,
  }
}

describe("usage buckets", () => {
  it("reads the ledger's normalized usage and refuses to guess at a raw one", () => {
    expect(usageBucketsOf(NORMALIZED)).toEqual({
      usage: {
        inputUncached: 100,
        inputCacheRead: 20,
        inputCacheWrite5m: 5,
        inputCacheWrite1h: 0,
        output: 40,
        reasoning: 12,
      },
      reasoningIncludedInOutput: true,
    })
    expect(usageBucketsOf({ raw: { inputTokens: 1 } })).toEqual({
      usage: null,
      reasoningIncludedInOutput: null,
    })
    expect(usageBucketsOf(null).usage).toBeNull()
  })

  it("adds buckets and ignores a call that reported none", () => {
    const one = usageBucketsOf(NORMALIZED).usage
    expect(addUsage(addUsage(emptyUsage(), one), null)).toEqual(one)
    expect(addUsage(one!, one).output).toBe(80)
  })
})

describe("callRecordsOf", () => {
  it("joins the ledger's attempts with what the executor saw, by attempt id", () => {
    const { calls, unledgeredCalls } = callRecordsOf(
      [attempt(), attempt({ attemptId: "a2", attemptNo: 2, providerRequestId: null })],
      [observed(), observed({ attemptId: "a2", providerRequestId: "req_2", latencyMs: 5 })]
    )
    expect(calls.map((call) => [call.attemptId, call.providerRequestId, call.latencyMs])).toEqual([
      ["a1", "req_1", 321],
      ["a2", "req_2", 5],
    ])
    expect(unledgeredCalls).toBe(0)
  })

  it("counts a call the ledger never reserved", () => {
    expect(
      callRecordsOf([attempt()], [observed(), observed({ attemptId: "ghost" })])
    ).toMatchObject({ unledgeredCalls: 1 })
  })

  it("keeps an attempt the executor never saw (a replay), with no latency", () => {
    expect(callRecordsOf([attempt()], []).calls[0]).toMatchObject({
      latencyMs: null,
      finishReason: null,
    })
  })
})

describe("summarizeRetries", () => {
  it("reports steps that needed more than one attempt and requests beyond one per call", () => {
    const { calls } = callRecordsOf(
      [
        attempt({ attemptId: "a1", state: "FAILED", errorClass: "rate_limited" }),
        attempt({ attemptId: "a2", attemptNo: 2 }),
        attempt({ attemptId: "a3", logicalStepId: "direct:review" }),
      ],
      [
        observed({ attemptId: "a1", retryAfterMs: 2_000 }),
        observed({ attemptId: "a2" }),
        observed({ attemptId: "a3" }),
      ]
    )
    expect(
      summarizeRetries(calls, { executorCalls: 3, unledgeredCalls: 0, httpRequests: 4 })
    ).toEqual({
      logicalSteps: 2,
      ledgerAttempts: 3,
      retriedSteps: [
        { logicalStepId: "direct:solver", attempts: 2, errorClasses: ["rate_limited"] },
      ],
      executorCalls: 3,
      unledgeredCalls: 0,
      httpRequests: 4,
      extraHttpRequests: 1,
      retryAfterMs: [2_000],
    })
    expect(
      summarizeRetries(calls, { executorCalls: 3, unledgeredCalls: 0, httpRequests: null })
        .extraHttpRequests
    ).toBeNull()
  })
})

describe("capabilityMatrix", () => {
  it("summarizes per deployment what the provider reported", () => {
    const withoutIds = caseReport({
      calls: callRecordsOf(
        [attempt({ deploymentId: "anthropic::claude", providerRequestId: null, usage: null })],
        [observed({ providerRequestId: null, attemptId: "a1", retryAfterMs: 10 })]
      ).calls,
    })
    expect(capabilityMatrix([caseReport(), withoutIds])).toEqual([
      {
        deploymentId: "anthropic::claude",
        providerId: "anthropic",
        calls: 1,
        succeeded: 1,
        requestIds: "none",
        usageBuckets: [],
        reasoningIncludedInOutput: null,
        retryAfterSeen: true,
        errorClasses: [],
      },
      {
        deploymentId: "openai::gpt-4o",
        providerId: "openai",
        calls: 1,
        succeeded: 1,
        requestIds: "all",
        usageBuckets: [
          "inputUncached",
          "inputCacheRead",
          "inputCacheWrite5m",
          "output",
          "reasoning",
        ],
        reasoningIncludedInOutput: true,
        retryAfterSeen: false,
        errorClasses: [],
      },
    ])
  })
})

describe("report", () => {
  it("sums what the cases spent", () => {
    expect(totalSpent([caseReport(), caseReport({ spentMicrousd: 766 })])).toBe(2_000)
  })

  it("previews an answer on one line, bounded", () => {
    expect(answerPreview("a\n\nb   c")).toBe("a b c")
    expect(answerPreview("x".repeat(400))).toHaveLength(280)
  })

  it("exits 0 only when every case succeeded or was skipped by the router", () => {
    expect(liveSmokeExitCode(report())).toBe(0)
    expect(
      liveSmokeExitCode(
        report({ cases: [caseReport(), caseReport({ id: "delegate", outcome: "skipped" })] })
      )
    ).toBe(0)
    expect(liveSmokeExitCode(report({ cases: [caseReport({ outcome: "refused" })] }))).toBe(1)
    expect(liveSmokeExitCode(report({ cases: [caseReport({ outcome: "not_run" })] }))).toBe(1)
  })

  it("renders a simulated report with its label and the no-claims disclaimer", () => {
    const markdown = renderLiveSmokeMarkdown(report())
    expect(markdown).toContain("# Router + Fusion live smoke: SIMULATED")
    expect(markdown).toContain(SIMULATED_DISCLAIMER)
    expect(SIMULATED_DISCLAIMER).toMatch(/no claim about real quality, latency, cost or savings/)
    // Request ids, usage buckets and the route are in the case table.
    expect(markdown).toContain(
      "| direct:solver | 1 | solver | openai::gpt-4o | SUCCEEDED | req_1 |"
    )
    expect(markdown).toContain("100/20/5/40/12")
    expect(markdown).toContain("`direct_baseline`")
  })

  it("escapes cell content so a value cannot break a table", () => {
    const calls = callRecordsOf([attempt({ errorClass: "a|b\nc" })], [observed()]).calls
    const markdown = renderLiveSmokeMarkdown(report({ cases: [caseReport({ calls })] }))
    expect(markdown).toContain("SUCCEEDED (a\\|b c)")
  })

  it("renders a live report as live", () => {
    const markdown = renderLiveSmokeMarkdown(
      report({ label: "live", disclaimer: disclaimerFor("live") })
    )
    expect(markdown).toContain("# Router + Fusion live smoke: LIVE")
    expect(markdown).not.toContain("SIMULATED")
  })
})
