/**
 * @cognia/agent-trace
 *
 * OpenTelemetry-compatible agent tracing toolkit:
 * - span lifecycle emitter (start/record/end, writer registry)
 * - OTLP serialization
 * - structured-log bridge (span ⇄ log entry)
 * - token cost estimation
 * - chat tool-call span helpers
 */

export * from "./emitter"
export * from "./cost-estimator"
export * from "./span-to-otlp"
export * from "./span-to-log-entry"
export * from "./log-adapter"
export * from "./chat-tool-spans"
