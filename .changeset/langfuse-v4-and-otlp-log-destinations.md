---
"cognia-next": minor
---

Observability destinations, reworked: an account-scoped Langfuse v4 project, and OTLP application logs of their own.

Langfuse is no longer a log sink. It consumes only the versioned `AgentTraceBatchV1` contract and exports to the fixed Langfuse v4 OTLP traces path, so the settings field is a base URL rather than a host plus a guessed suffix. The current signed-in account owns one BYO project: five narrow Host commands set, inspect, clear, test and ingest, the secret key is write-only and account-scoped, and an ingest caller cannot supply an endpoint, headers, credentials or an arbitrary OTLP document. The desktop exports from its own Host; paired web and mobile clients go through the same companion transport; a standalone static web build keeps its traces local. Model content and tool content are separate opt-ins and both default to off, with bounded field-level filtering and the PII gate on every outbound path. A "Test connection" button reports what the Host actually got back.

"OTLP application logs" is now its own destination, exporting redacted `LogRecord`s independently of agent traces, and a console bridge installed before hydration routes pre-bootstrap `console` calls into the unified logger. The free-text OTLP headers field is gone: it invited an `Authorization` header into renderer-visible settings, so the desktop signs requests in the Host and a browser build may only point at a credentialless collector — Grafana Cloud credentials are refused outside the Host, and the endpoint is validated to carry no query or fragment. The panel is renamed "Observability Destinations", which is what it configures.

The sidecar keeps one `NodeSDK` with separate processors for generic OTLP, PostHog and the official Langfuse v4 integration; AI SDK generations and tool calls are re-parented under the renderer's W3C trace context, and correlation fields (session, run, turn, attempt, project, prompt fingerprint) travel with every call.
