import { EXPECTED_TIMELINE, FIXTURE_END, FIXTURE_START, FIXTURE_TRACE_ID } from "./fixtures"
import { createSreRuntime, defaultIncidentWindow } from "./runtime"
import type { SreLogProvider } from "./providers/types"

function runtime() {
  return createSreRuntime({ pluginId: "sre-agent" })
}

describe("SRE mock runtime", () => {
  it("exposes the bundled incident window", () => {
    expect(defaultIncidentWindow()).toEqual({ startTime: FIXTURE_START, endTime: FIXTURE_END })
  })

  it("filters JSON and text logs by trace, service and keywords", async () => {
    const result = await runtime().queryLogs({
      environment: "prod",
      startTime: FIXTURE_START,
      endTime: FIXTURE_END,
      services: ["gateway"],
      traceId: FIXTURE_TRACE_ID,
      keywords: ["fallback"],
    })

    expect(result.records.map((record) => record.id)).toEqual(["log_004"])
    expect(result.records[0].eventName).toBe("provider.fallback")
  })

  it("returns trace spans by trace id", async () => {
    const result = await runtime().queryTrace({
      environment: "prod",
      traceId: FIXTURE_TRACE_ID,
    })

    expect(result.records).toHaveLength(5)
    expect(result.records.map((span) => span.id)).toEqual(
      expect.arrayContaining(["span_001", "span_002", "span_004"])
    )
  })

  it("applies optional trace windows and rejects incomplete ranges", async () => {
    const result = await runtime().queryTrace({
      environment: "prod",
      traceId: FIXTURE_TRACE_ID,
      startTime: "2026-08-04T12:02:54.306Z",
      endTime: FIXTURE_END,
    })

    expect(result.records.map((record) => record.id)).toEqual(["span_001", "span_005"])
    await expect(
      runtime().queryTrace({
        environment: "prod",
        traceId: FIXTURE_TRACE_ID,
        startTime: FIXTURE_START,
      })
    ).rejects.toThrow("endTime must be a non-empty string")
  })

  it("requires a trace id or request id for trace queries", async () => {
    await expect(runtime().queryTrace({ environment: "prod" })).rejects.toThrow(
      "traceId or requestId is required"
    )
  })

  it("supports request-id lookup and returns no records for unknown traces", async () => {
    await expect(
      runtime().queryTrace({ environment: "prod", requestId: "req_timeout_001" })
    ).resolves.toMatchObject({ evidenceIds: expect.arrayContaining(["span_001"]) })
    await expect(
      runtime().queryTrace({ environment: "prod", traceId: "unknown" })
    ).resolves.toMatchObject({ records: [] })
  })

  it.each([
    ["invalid", FIXTURE_END, "valid ISO timestamps"],
    [FIXTURE_END, FIXTURE_START, "startTime must be before endTime"],
  ])("rejects invalid query range %s to %s", async (startTime, endTime, message) => {
    await expect(runtime().queryLogs({ environment: "prod", startTime, endTime })).rejects.toThrow(
      message
    )
  })

  it("filters metric evidence by job, metric name and labels", async () => {
    const result = await runtime().queryMetrics({
      environment: "prod",
      startTime: FIXTURE_START,
      endTime: FIXTURE_END,
      jobs: ["vllm"],
      metrics: ["vllm:num_requests_waiting"],
      labels: { model_name: "Qwen/Qwen3-32B" },
    })

    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      id: "metric_002",
      interpretation: "queue_pressure",
    })
  })

  it("does not return metrics outside the requested incident window", async () => {
    const result = await runtime().queryMetrics({
      environment: "prod",
      startTime: "2026-08-04T13:00:00.000Z",
      endTime: "2026-08-04T13:05:00.000Z",
    })

    expect(result.records).toEqual([])
  })

  it("returns no metrics when job, name, or labels do not match", async () => {
    const rt = runtime()
    const base = { environment: "prod", startTime: FIXTURE_START, endTime: FIXTURE_END }
    await expect(rt.queryMetrics({ ...base, jobs: ["missing"] })).resolves.toMatchObject({
      records: [],
    })
    await expect(rt.queryMetrics({ ...base, metrics: ["missing"] })).resolves.toMatchObject({
      records: [],
    })
    await expect(
      rt.queryMetrics({ ...base, labels: { model_name: "missing" } })
    ).resolves.toMatchObject({ records: [] })
  })

  it("redacts PII before returning or retaining evidence", async () => {
    const rt = runtime()
    const result = await rt.queryLogs({
      environment: "prod",
      startTime: FIXTURE_START,
      endTime: FIXTURE_END,
      requestId: "req_timeout_001",
    })

    expect(JSON.stringify(result.records)).not.toMatch(/t-001|u-123|ak_789/)
    expect(JSON.stringify(rt.evidenceSnapshot())).not.toMatch(/t-001|u-123|ak_789/)
  })

  it("validates a timeline against accumulated evidence", async () => {
    const rt = runtime()
    await rt.queryLogs({
      environment: "prod",
      startTime: FIXTURE_START,
      endTime: FIXTURE_END,
      traceId: FIXTURE_TRACE_ID,
    })
    await rt.queryTrace({ environment: "prod", traceId: FIXTURE_TRACE_ID })
    await rt.queryMetrics({
      environment: "prod",
      startTime: FIXTURE_START,
      endTime: FIXTURE_END,
      metrics: ["gateway_llm_fallbacks_total"],
    })

    const valid = await rt.validateTimeline({
      rows: [
        {
          time: "12:02:54.312",
          component: "gateway",
          event: "fallback qwen-vllm-a to qwen-vllm-b",
          signals: ["timeout", "fallback"],
          evidenceIds: ["log_004", "metric_001"],
          sources: ["logs", "metrics"],
          confidence: 0.95,
          flags: ["timeout", "fallback"],
        },
      ],
      findings: [
        { text: "fallback followed provider timeout", evidenceIds: ["log_003", "log_004"] },
      ],
    })

    expect(valid).toEqual({ ok: true, issues: [], evidenceCount: 13 })
  })

  it("validates every row in the checked-in golden incident timeline", async () => {
    const rt = runtime()
    await rt.queryLogs({
      environment: "prod",
      startTime: FIXTURE_START,
      endTime: FIXTURE_END,
      traceId: FIXTURE_TRACE_ID,
    })
    await rt.queryTrace({ environment: "prod", traceId: FIXTURE_TRACE_ID })
    await rt.queryMetrics({
      environment: "prod",
      startTime: FIXTURE_START,
      endTime: FIXTURE_END,
    })

    const result = await rt.validateTimeline({
      rows: EXPECTED_TIMELINE.map((row) => ({
        ...row,
        time: FIXTURE_START,
        signals: [],
        sources: [
          ...new Set(
            row.evidenceIds.map((id) =>
              id.startsWith("log_") ? "logs" : id.startsWith("span_") ? "trace" : "metrics"
            )
          ),
        ] as Array<"logs" | "trace" | "metrics">,
        confidence: 0.95,
        flags: [],
      })),
      findings: [
        { text: "fallback followed the observed timeout", evidenceIds: ["log_003", "log_004"] },
      ],
      recommendations: [
        { text: "inspect queue pressure before changing thresholds", evidenceIds: ["metric_002"] },
      ],
    })

    expect(result).toMatchObject({ ok: true, issues: [] })
  })
})

describe("SRE runtime over the provider seam", () => {
  const WINDOW = { startTime: FIXTURE_START, endTime: FIXTURE_END }
  const QUERY = { environment: "prod", ...WINDOW }

  function stubProvider(overrides: Partial<SreLogProvider> = {}): SreLogProvider {
    return {
      id: "stub",
      kind: "remote",
      coverage: () => null,
      fetchLogs: async () => [],
      fetchTrace: async () => [],
      fetchMetrics: async () => [],
      ambientEvidence: () => [],
      histogram: async () => [],
      patterns: async () => [],
      facets: async () => [],
      sources: async () => [],
      ...overrides,
    }
  }

  it("reports which backend answered", () => {
    expect(runtime().provider()).toEqual({
      id: "qwen-timeout-fallback",
      kind: "fixture",
      coverage: WINDOW,
    })
  })

  it("names the fixture corpus only when a fixture answered", async () => {
    await expect(runtime().queryLogs(QUERY)).resolves.toMatchObject({
      provider: "qwen-timeout-fallback",
      fixture: "qwen-timeout-fallback",
    })
    const remote = await createSreRuntime({ pluginId: "sre-agent" }, stubProvider()).queryLogs(
      QUERY
    )
    expect(remote.provider).toBe("stub")
    expect(remote).not.toHaveProperty("fixture")
  })

  it("falls back to the last hour when the backend is unbounded", () => {
    const window = defaultIncidentWindow(stubProvider())
    const span = Date.parse(window.endTime) - Date.parse(window.startTime)
    expect(span).toBe(60 * 60 * 1000)
  })

  it("buckets the window and validates it like a query does", async () => {
    const buckets = await runtime().histogram(QUERY, 4)
    expect(buckets).toHaveLength(4)
    expect(buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(9)
    await expect(runtime().histogram({ ...QUERY, startTime: "nope" }, 4)).rejects.toThrow(
      "valid ISO timestamps"
    )
  })

  it("rejects an invalid baseline window before querying patterns", async () => {
    await expect(
      runtime().patterns(QUERY, { startTime: FIXTURE_END, endTime: FIXTURE_START })
    ).rejects.toThrow("startTime must be before endTime")
  })

  it("redacts a template that carried an unmasked secret", async () => {
    const rt = createSreRuntime(
      { pluginId: "sre-agent" },
      stubProvider({
        patterns: async () => [
          {
            id: "tpl_1",
            template: "auth failed key=ak_live1 from 10.1.2.3",
            count: 3,
            baselineCount: null,
            changeRatio: null,
            services: ["gateway"],
            levels: ["error"],
            firstSeen: FIXTURE_START,
            lastSeen: FIXTURE_END,
            evidenceIds: ["log_x"],
          },
        ],
      })
    )
    const [pattern] = await rt.patterns(QUERY)
    expect(pattern.template).toBe("auth failed key=ak_[redacted] from [ip-redacted]")
  })

  it("drops sensitive facet fields before the backend sees them", async () => {
    const seen: string[][] = []
    const rt = createSreRuntime(
      { pluginId: "sre-agent" },
      stubProvider({
        facets: async (_filter, fields) => {
          seen.push([...fields])
          return fields.map((field) => ({ field, total: 0, values: [] }))
        },
      })
    )

    await rt.facets(QUERY, ["service", "tenant_id", "api_key_id", "user_id", "client_ip"])
    expect(seen).toEqual([["service"]])
    await expect(rt.facets(QUERY, ["tenant_id"])).resolves.toEqual([])
    expect(seen).toHaveLength(1)
  })

  it("redacts facet values and source descriptions on the way out", async () => {
    const rt = createSreRuntime(
      { pluginId: "sre-agent" },
      stubProvider({
        facets: async () => [
          { field: "peer", total: 2, values: [{ value: "10.1.2.3", count: 2 }] },
        ],
        sources: async () => [
          {
            id: "s1",
            label: "collector u-42",
            pipeline: "syslog from 10.0.0.9",
            status: "healthy",
            lagMs: 1200,
            recordCount: 10,
            bytes24h: 42,
          },
        ],
      })
    )

    await expect(rt.facets(QUERY, ["peer"])).resolves.toEqual([
      { field: "peer", total: 2, values: [{ value: "[ip-redacted]", count: 2 }] },
    ])
    await expect(rt.sources()).resolves.toMatchObject([
      { label: "collector [subject-redacted]", pipeline: "syslog from [ip-redacted]" },
    ])
  })

  it("keeps ambient runbook evidence in the snapshot", () => {
    expect(
      runtime()
        .evidenceSnapshot()
        .map((entry) => entry.source)
    ).toEqual(["runbook"])
  })
})
