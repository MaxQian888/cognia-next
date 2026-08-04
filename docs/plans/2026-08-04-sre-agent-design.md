# SRE Agent Design

## Goal

Build a GPT-style SRE Agent as an independent Cognia plugin that investigates
an alert or trace question by calling observability tools, then produces an
auditable call-chain timeline table and operational recommendations.

The first version uses realistic mock production metrics, logs, traces, and
runbooks. It does not connect to real Prometheus, Loki, Tempo, Grafana, or
production credentials yet.

This design follows `docs/plans/sre-agent-guide.md`: the SRE Agent is a
first-party plugin under `plugins/sre-agent/`, not a host-level built-in
subagent. It declares a `subagent` contribution and registers read-only SRE
tools through `ctx.agent.registerTool()`.

## Plugin Boundary

Target structure:

```text
plugins/sre-agent/
  plugin.json
  src/
    index.ts
    index.test.ts
    subagents.ts
    subagents.test.ts
    tools.ts
    tools.test.ts
    runtime.ts
    runtime.test.ts
```

The plugin must not modify `lib/claude/agents/subagents/`. The plugin manager
projects the declared subagent into the host registry while the plugin is
enabled and removes it when the plugin is disabled.

Manifest scope:

- `capabilities`: `["tools", "subagent"]`
- initial permissions: read-only plugin APIs such as `network:fetch` and
  `secrets:read` only when real remote observability is configured
- no production mutation tools such as restart, rollback, scale, or config
  writes
- no broad wildcard network access

The subagent id exposed by the host is expected to be:

```text
sre-agent:incident-diagnostician
```

## Product Shape

The product experience is a chat surface, not a dashboard panel. The chat can
be reached through the plugin-provided SRE subagent entry rather than a
hard-coded host page.

Users can ask questions such as:

- `qwen-vllm-a upstream timeout, help me investigate`
- `trace_id=9aa1... why was this slow?`
- pasted gateway or vLLM log excerpts

The assistant response is structured in this order:

1. Complete call-chain timeline table
2. Key findings
3. Recommended actions
4. Expandable evidence details

## Source Model

Production observability is modeled as three raw outlet families plus one
shared trace correlation line.

| Family         | Raw outlets                                      | Examples                               |
| -------------- | ------------------------------------------------ | -------------------------------------- |
| Application    | metrics, JSON logs, OTLP traces                  | MaaS, Admin, Gateway                   |
| Inference      | vLLM `/metrics`, stdout/stderr logs, OTLP traces | vLLM server                            |
| Infrastructure | metrics and logs                                 | K8s, container, GPU, Redis, PostgreSQL |

The common correlation fields are:

- `trace_id`
- `request_id`
- `provider`
- `model`
- `tenant_id`
- time window

Sensitive fields such as `tenant_id`, `user_id`, `api_key_id`, and IP address
must be available for correlation but redacted by default in user-facing
summaries.

## Tool Surface

The SRE Agent uses two tool groups.

### SRE Evidence Tools

These tools query observability evidence. The first version is backed by mock
fixture files.

```ts
queryLogs(input) -> LogEvidence[]
queryTrace(input) -> TraceSpanEvidence[]
queryMetrics(input) -> MetricEvidence[]
```

The tools return evidence, not final conclusions.

Plugin tool names should follow the guide's plugin-safe naming style:

```text
sre_query_logs
sre_query_trace
sre_query_metrics
sre_list_alerts
sre_get_deployment_status
```

The first mock-backed implementation may only need `sre_query_logs`,
`sre_query_trace`, and `sre_query_metrics`. Deployment and alert tools can wait
until they are needed by a fixture or real integration.

### General Investigation Tools

The agent can reuse the existing Claude Agent SDK tool surface for local
investigation when the host policy grants those tools:

- `Read`
- `Grep`
- `Glob`
- `Bash`, subject to existing permission controls

These tools are used for runbooks, mock fixtures, service configuration, local
analysis scripts, and historical incident documents. They must stay read-only
for the initial SRE agent. Production observability queries should still go
through SRE evidence tools so authentication, redaction, audit, and query
limits remain centralized.

The plugin guide is stricter for production: the plugin should not request
shell execution or file-write permissions in version 1. If Read/Grep-style host
tools are enabled for mock investigation, they should be scoped to fixture and
runbook paths. Mutating tools remain disallowed.

## Evidence Types

### Log Evidence

Gateway and MaaS logs are structured JSON. vLLM logs are Python stdout/stderr
text and require weak parsing while preserving the raw line.

```ts
interface LogEvidence {
  id: string
  source: "logs"
  sourceKind: "json" | "text"
  time: string
  service: string
  component?: string
  level?: "debug" | "info" | "warn" | "error"
  eventName?: string
  raw: string | Record<string, unknown>
  parsedFields?: Record<string, unknown>
}
```

Logs provide request start/end, routing, auth, rate limit, retry, fallback,
status, and natural-language runtime symptoms.

### Trace Evidence

Trace spans provide the call skeleton and duration.

```ts
interface TraceSpanEvidence {
  id: string
  source: "trace"
  traceId: string
  spanId: string
  parentSpanId?: string
  service: string
  name: string
  startTime: string
  endTime?: string
  durationMs?: number
  status: "ok" | "error"
  attributes: Record<string, unknown>
}
```

Traces provide span parent-child relationships, stage latency, selected
providers, request metadata, and span-level failures.

### Metric Evidence

Metrics are context and anomaly evidence, not request events by default.

```ts
interface MetricEvidence {
  id: string
  source: "metrics"
  job: string
  metric: string
  timeRange: [string, string]
  labels: Record<string, string>
  value: number
  unit?: string
  valueKind: "gauge" | "counter_delta" | "histogram_quantile"
  interpretation?: string
}
```

Examples include:

- `gateway_llm_errors_total`
- `gateway_llm_retries_total`
- `gateway_llm_fallbacks_total`
- `vllm:num_requests_waiting`
- `vllm:gpu_cache_usage_perc`
- `DCGM_FI_DEV_GPU_UTIL`

Metrics annotate key rows, such as a timeout row near a queue-depth spike.

## Agent Investigation Flow

The agent owns the investigation and final table construction.

When the user provides `trace_id` or `request_id`:

1. Call `queryTrace`
2. Extract services, provider, model, and time window from the trace
3. Call `queryLogs`
4. Call `queryMetrics`
5. Build the timeline table
6. Summarize findings and actions

When the user provides only an alert:

1. Extract service, provider, model, error class, and time window
2. Call `queryMetrics` to understand the incident window
3. Call `queryLogs` to find candidate `trace_id` or `request_id`
4. Call `queryTrace` for top candidates
5. Produce a single-request timeline when possible
6. Fall back to an aggregate incident timeline when no single trace is found

When the user pastes logs:

1. Treat the pasted text as local evidence
2. Extract time, component, event, status, attempt, provider, and model
3. Query trace and metrics when identifiers or time windows are available
4. Complete the timeline from all evidence

## Timeline Output

The visible table uses compact columns:

| Time | Component | Event | Signals | Evidence |
| ---- | --------- | ----- | ------- | -------- |

The underlying structured row is:

```ts
interface TimelineRow {
  time: string
  component: string
  event: string
  signals: string[]
  evidenceIds: string[]
  sources: Array<"logs" | "trace" | "metrics" | "file" | "runbook">
  confidence: number
  flags: Array<"error" | "timeout" | "retry" | "fallback" | "slow" | "infra">
  notes?: string
}
```

Every timeline row must cite at least one evidence id. Unsupported inferences
must not become table rows. They may appear in findings only when explicitly
qualified and supported by cited evidence.

## Validator

A lightweight validator runs before the final answer is shown.

It verifies:

- every timeline row has evidence ids
- every evidence id exists
- service, provider, status, model, and latency values are present in evidence
- metrics are used as context/anomaly evidence, not fabricated request events
- sensitive fields are redacted in user-facing text

If validation fails, the agent must revise its answer.

## First Mock Incident

The first golden fixture should model:

```text
qwen-vllm-a timeout
-> gateway fallback to qwen-vllm-b
-> final request succeeds
-> total latency is high
```

Suggested fixture layout:

```text
plugins/sre-agent/fixtures/qwen-timeout-fallback/
  alert.json
  metrics.prom
  gateway.logs.jsonl
  maas.logs.jsonl
  vllm.stdout.log
  trace.json
  runbook.md
  expected.timeline.json
  expected.answer.md
```

The fixture should include evidence for request acceptance, route selection,
provider timeout, fallback, vLLM queue or decode pressure, final status 200,
and elevated total latency.

## Testing Strategy

All implementation tests are colocated under `plugins/sre-agent/src/`, matching
the plugin guide.

Plugin contribution tests:

- manifest includes `tools` and `subagent`
- manifest permissions match actual API usage
- subagent id, name, description, prompt, effort, and max turn budget are
  correct
- tool whitelist contains only read-only SRE tools and approved read-only host
  tools
- mutating tools are absent or explicitly disallowed

Tool tests:

- registered tool names and JSON schemas are correct
- missing service, environment, or time window is rejected
- `sre_query_logs` reads JSON logs and vLLM text logs
- `sre_query_trace` returns a trace tree
- `sre_query_metrics` parses Prometheus text exposition
- real-provider code uses `ctx.network`, not global `fetch`
- credentials are read through `ctx.secrets` and never returned or logged
- oversized responses, malformed responses, timeout, and cancellation fail
  safely

Agent behavior tests:

- an alert causes logs, trace, and metrics queries
- the response includes a complete timeline table
- every row cites evidence
- findings cite evidence

Validator tests:

- missing evidence ids fail
- fabricated provider/status/latency values fail
- unsupported inferences are rejected from the table
- sensitive fields are redacted

## Version 1 Scope

Included:

- first-party `plugins/sre-agent/`
- plugin-declared SRE subagent
- realistic mock production fixture
- mock SRE query tools
- optional read-only general investigation tools through the existing agent
  tool surface, scoped to fixtures and runbooks
- timeline output schema
- evidence pool
- validator
- golden tests

Excluded:

- real Prometheus/Loki/Tempo/Grafana connectors
- real production credentials
- alert-platform integration
- dashboard-first workflows
- multi-tenant production access policy
- restart, rollback, scale, or any production mutation
