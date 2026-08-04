import { FIXTURE_END, FIXTURE_START, FIXTURE_TRACE_ID } from "./fixtures"
import { createSreRuntime } from "./runtime"

function runtime() {
  return createSreRuntime({ pluginId: "sre-agent" })
}

describe("SRE mock runtime", () => {
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

  it("requires a trace id or request id for trace queries", async () => {
    await expect(runtime().queryTrace({ environment: "prod" })).rejects.toThrow(
      "traceId or requestId is required"
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

    expect(valid).toEqual({ ok: true, issues: [], evidenceCount: 11 })
  })
})
