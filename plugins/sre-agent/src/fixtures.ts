import alertFixture from "../fixtures/qwen-timeout-fallback/alert.json"
import expectedTimelineFixture from "../fixtures/qwen-timeout-fallback/expected.timeline.json"
import traceFixture from "../fixtures/qwen-timeout-fallback/trace.json"
import type {
  SreLogEvidence,
  SreMetricEvidence,
  SreRunbookEvidence,
  SreTraceSpanEvidence,
} from "./evidence"

export const FIXTURE_TRACE_ID = traceFixture.trace_id
export const FIXTURE_REQUEST_ID = "req_timeout_001"
export const FIXTURE_START = "2026-08-04T12:02:00.000Z"
export const FIXTURE_END = "2026-08-04T12:05:20.000Z"

/** Raw outlet text embedded into the browser bundle and pinned against fixture files in tests. */
export const FIXTURE_SOURCE_TEXT = {
  gatewayLogs: [
    '{"ts":"2026-08-04T12:02:09.113Z","level":"info","service":"gateway","event":"request.accepted","trace_id":"9aa10000000000000000000000000001","request_id":"req_timeout_001","tenant_id":"t-001","user_id":"u-123","api_key_id":"ak_789","surface":"responses","model":"qwen3-32b","stream":true}',
    '{"ts":"2026-08-04T12:02:09.121Z","level":"info","service":"gateway","event":"route.selected","trace_id":"9aa10000000000000000000000000001","model":"qwen3-32b","strategy":"least_gpu_cache","candidates":["qwen-vllm-a","qwen-vllm-b"],"selected_provider":"qwen-vllm-a","reason":"lowest_load"}',
    '{"ts":"2026-08-04T12:02:54.305Z","level":"error","service":"gateway","event":"provider.timeout","trace_id":"9aa10000000000000000000000000001","provider":"qwen-vllm-a","model":"qwen3-32b","error_class":"timeout","attempt":1,"upstream_latency_ms":45184}',
    '{"ts":"2026-08-04T12:02:54.312Z","level":"warn","service":"gateway","event":"provider.fallback","trace_id":"9aa10000000000000000000000000001","from_provider":"qwen-vllm-a","to_provider":"qwen-vllm-b","error_class":"timeout","attempt":2}',
    '{"ts":"2026-08-04T12:05:15.400Z","level":"info","service":"gateway","event":"request.completed","trace_id":"9aa10000000000000000000000000001","response_id":"resp_timeout_001","provider":"qwen-vllm-b","status":200,"latency_ms":186287,"upstream_latency_ms":140312,"prompt_tokens":60798,"completion_tokens":977,"cached_tokens":54912}',
  ].join("\n"),
  maasLogs: [
    '{"ts":"2026-08-04T12:02:09.150Z","level":"info","service":"maas","event":"budget.reserve","trace_id":"9aa10000000000000000000000000001","tenant_id":"t-001","reserved_usd":0.42}',
    '{"ts":"2026-08-04T12:05:15.430Z","level":"info","service":"maas","event":"usage.persist","trace_id":"9aa10000000000000000000000000001","tenant_id":"t-001","status":"ok"}',
  ].join("\n"),
  metrics: [
    'gateway_llm_fallbacks_total{from_provider="qwen-vllm-a",to_provider="qwen-vllm-b",reason="timeout"} 17',
    'vllm:num_requests_waiting{model_name="Qwen/Qwen3-32B"} 3',
    'vllm:gpu_cache_usage_perc{model_name="Qwen/Qwen3-32B"} 0.72',
  ].join("\n"),
  vllmLogs: [
    "WARNING 08-04 12:02:20 scheduler.py:391] Sequence group waiting too long in queue",
    "INFO 08-04 12:02:21 metrics.py:201] Avg prompt throughput: 18342.1 tokens/s, Avg generation throughput: 4182.4 tokens/s, Running: 8 reqs, Pending: 3 reqs, GPU KV cache usage: 72.0%",
  ].join("\n"),
  runbook: [
    "# qwen-vLLM timeout fallback runbook",
    "",
    "- Check vLLM waiting queue and decode latency before changing fallback thresholds.",
    "- Confirm fallback provider health before raising upstream timeout.",
    "- Do not restart or scale production from the SRE Agent.",
  ].join("\n"),
} as const

export const FIXTURE_ALERT = alertFixture
export const EXPECTED_TIMELINE = expectedTimelineFixture

function componentForLog(raw: Record<string, unknown>): string {
  if (raw.event === "route.selected") return "router"
  if (raw.event === "provider.timeout") return "provider"
  return String(raw.service)
}

/** Parse structured JSONL logs while preserving each original record as evidence. */
export function parseJsonLogEvidence(rawText: string, idPrefix: string): SreLogEvidence[] {
  return rawText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const raw = JSON.parse(line) as Record<string, unknown>
      return {
        id: `${idPrefix}_${String(index + 1).padStart(3, "0")}`,
        source: "logs" as const,
        sourceKind: "json" as const,
        time: String(raw.ts),
        service: String(raw.service),
        component: componentForLog(raw),
        level: raw.level as SreLogEvidence["level"],
        eventName: String(raw.event),
        traceId: typeof raw.trace_id === "string" ? raw.trace_id : undefined,
        requestId: typeof raw.request_id === "string" ? raw.request_id : undefined,
        raw,
      }
    })
}

/** Parse vLLM stdout/stderr lines without discarding their unstructured payload. */
export function parseVllmLogEvidence(rawText: string): SreLogEvidence[] {
  return rawText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((raw, index) => {
      const match = /^(WARNING|INFO|ERROR) (\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})/.exec(raw)
      if (!match) throw new Error(`invalid vLLM log line: ${raw}`)
      const level = match[1] === "WARNING" ? "warn" : match[1].toLowerCase()
      const queueWarning = raw.includes("waiting too long")
      return {
        id: `log_vllm_${String(index + 1).padStart(3, "0")}`,
        source: "logs" as const,
        sourceKind: "text" as const,
        time: `2026-${match[2]}-${match[3]}T${match[4]}.000Z`,
        service: "vllm-server",
        component: queueWarning ? "vllm-scheduler" : "vllm-metrics",
        level: level as SreLogEvidence["level"],
        eventName: queueWarning ? "vllm.queue_wait_warning" : "vllm.throughput_snapshot",
        raw,
        parsed: queueWarning
          ? { symptom: "queue_wait" }
          : { runningRequests: 8, pendingRequests: 3, gpuCacheUsage: 0.72 },
      }
    })
}

const METRIC_METADATA: Record<
  string,
  Pick<SreMetricEvidence, "job" | "service" | "valueKind" | "interpretation" | "unit">
> = {
  gateway_llm_fallbacks_total: {
    job: "gateyes-gateway",
    service: "gateway",
    valueKind: "counter_delta",
    interpretation: "fallback_spike",
  },
  "vllm:num_requests_waiting": {
    job: "vllm",
    service: "vllm-server",
    valueKind: "gauge",
    interpretation: "queue_pressure",
    unit: "requests",
  },
  "vllm:gpu_cache_usage_perc": {
    job: "vllm",
    service: "vllm-server",
    valueKind: "gauge",
    interpretation: "gpu_cache_pressure",
  },
}

function parsePrometheusLabels(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  return Object.fromEntries(
    [...raw.matchAll(/([a-zA-Z_][\w]*)="([^"]*)"/g)].map((match) => [match[1], match[2]])
  )
}

/** Parse the bundled Prometheus exposition into typed contextual evidence. */
export function parsePrometheusEvidence(rawText: string): SreMetricEvidence[] {
  return rawText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((raw, index) => {
      const match = /^([^\s{]+)(?:\{([^}]*)\})?\s+(-?\d+(?:\.\d+)?)$/.exec(raw)
      if (!match) throw new Error(`invalid Prometheus sample: ${raw}`)
      const metric = match[1]
      const metadata = METRIC_METADATA[metric]
      if (!metadata) throw new Error(`unsupported fixture metric: ${metric}`)
      return {
        id: `metric_${String(index + 1).padStart(3, "0")}`,
        source: "metrics" as const,
        metric,
        timeRange: [FIXTURE_START, FIXTURE_END],
        labels: parsePrometheusLabels(match[2]),
        value: Number(match[3]),
        raw,
        ...metadata,
      }
    })
}

export const LOG_EVIDENCE: SreLogEvidence[] = [
  ...parseJsonLogEvidence(FIXTURE_SOURCE_TEXT.gatewayLogs, "log"),
  ...parseJsonLogEvidence(FIXTURE_SOURCE_TEXT.maasLogs, "log_maas"),
  ...parseVllmLogEvidence(FIXTURE_SOURCE_TEXT.vllmLogs),
]

const TRACE_TIMING: Record<string, { startTime: string; endTime: string; component: string }> = {
  "span-root": {
    startTime: "2026-08-04T12:02:09.113Z",
    endTime: "2026-08-04T12:05:15.400Z",
    component: "gateway",
  },
  "span-provider-a": {
    startTime: "2026-08-04T12:02:09.190Z",
    endTime: "2026-08-04T12:02:54.305Z",
    component: "provider",
  },
  "span-vllm-enqueue": {
    startTime: "2026-08-04T12:02:09.220Z",
    endTime: "2026-08-04T12:02:11.320Z",
    component: "vllm-scheduler",
  },
  "span-vllm-decode": {
    startTime: "2026-08-04T12:02:12.000Z",
    endTime: "2026-08-04T12:02:54.120Z",
    component: "vllm-decode",
  },
  "span-provider-b": {
    startTime: "2026-08-04T12:02:54.340Z",
    endTime: "2026-08-04T12:05:14.652Z",
    component: "provider",
  },
}

export const TRACE_EVIDENCE: SreTraceSpanEvidence[] = traceFixture.spans.map((span, index) => {
  const timing = TRACE_TIMING[span.span_id]
  const provider = /qwen-vllm-[ab]/.exec(span.name)?.[0]
  return {
    id: `span_${String(index + 1).padStart(3, "0")}`,
    source: "trace",
    traceId: traceFixture.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id,
    service: span.service,
    component: timing.component,
    name: span.name,
    startTime: timing.startTime,
    endTime: timing.endTime,
    durationMs: span.duration_ms,
    status: span.status as SreTraceSpanEvidence["status"],
    attributes: {
      ...(provider ? { "llm.provider": provider } : {}),
      ...(span.name.includes("vllm") || span.span_id === "span-root"
        ? { "llm.model": "qwen3-32b" }
        : {}),
      ...(span.status === "error" ? { "error.type": "timeout" } : {}),
      ...(span.span_id === "span-root" || span.span_id === "span-provider-b"
        ? { "http.status_code": 200 }
        : {}),
    },
    raw: `${span.name} service=${span.service} ${span.duration_ms}ms status=${span.status}`,
  }
})

export const METRIC_EVIDENCE = parsePrometheusEvidence(FIXTURE_SOURCE_TEXT.metrics)

export const RUNBOOK_EVIDENCE: SreRunbookEvidence[] = [
  {
    id: "runbook_001",
    source: "runbook",
    title: "qwen-vLLM timeout fallback runbook",
    service: "gateway",
    raw: FIXTURE_SOURCE_TEXT.runbook,
    parsed: { provider: "qwen-vllm-a", remediation: "read_only_diagnosis" },
  },
]
