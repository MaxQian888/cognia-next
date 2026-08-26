/**
 * Logger Transports — app barrel (ADR-0068 E4). Re-exports the
 * framework-agnostic implementations from `@cognia/logging/transports` plus
 * the app-coupled ones that stay here (native bridge, crash breadcrumbs,
 * agent-trace Dexie sink, OTLP with PII redaction, Langfuse client).
 */

export * from "@cognia/logging/transports"
export {
  LangfuseTransport,
  createLangfuseTransport,
  type LangfuseTransportOptions,
} from "./langfuse-transport"
export {
  NativeTransport,
  createNativeTransport,
  type NativeTransportOptions,
} from "./native-transport"
export {
  BreadcrumbTransport,
  createBreadcrumbTransport,
  type BreadcrumbTransportOptions,
} from "./breadcrumb-transport"
export {
  AgentTraceTransport,
  createAgentTraceTransport,
  type AgentTraceTransportOptions,
} from "./agent-trace-transport"
export {
  OtlpHttpTransport,
  createOtlpHttpTransport,
  type OtlpHttpTransportOptions,
} from "./otlp-http-transport"
export {
  OtlpLogTransport,
  createOtlpLogTransport,
  type OtlpLogTransportOptions,
} from "./otlp-log-transport"
