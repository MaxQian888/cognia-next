/**
 * Langfuse v4 AI-trace transport.
 *
 * It accepts only Cognia AgentTraceSpan log envelopes, pins the destination to
 * Langfuse's OTLP traces endpoint, and relies on the host fetch adapter to add
 * Basic Auth without exposing the secret key to the renderer.
 */

import type { AgentTraceBatchV1 } from "@cognia/agent-trace"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

import { OtlpHttpTransport, type OtlpHttpTransportOptions } from "./otlp-http-transport"

export interface LangfuseTransportOptions {
  enabled: boolean
  baseUrl: string
  publicKey: string
  /** Write-only secret status; the value itself stays in the host secret store. */
  secretKeyConfigured: boolean
  environment: string
  release?: string
  captureModelContent: boolean
  captureToolContent: boolean
  bufferSize?: number
  flushInterval?: number
  maxRetries?: number
  retryBaseMs?: number
  maxPreviewBytes?: number
  requestTimeoutMs?: number
  maxRequestBytes?: number
  spanFilter?: (span: AgentTraceSpan) => boolean
  /** Route a sanitized AgentTraceBatchV1 through the authenticated Cognia Host. */
  hostIngest: (batch: AgentTraceBatchV1) => Promise<{ status: number }>
}

export class LangfuseTransport extends OtlpHttpTransport {
  constructor(options: LangfuseTransportOptions) {
    const configured =
      options.enabled &&
      options.publicKey.trim().length > 0 &&
      options.secretKeyConfigured &&
      options.baseUrl.trim().length > 0
    // This address is an internal transport sentinel. `createHostIngestFetch`
    // ignores it and calls the authenticated Cognia Host; only Rust resolves
    // the configured Langfuse URL and pins the v4 traces path/headers.
    const endpoint = configured ? "cognia-host://langfuse_trace_ingest" : ""
    const otlpOptions: OtlpHttpTransportOptions = {
      transportName: "langfuse",
      destinationFingerprint: `${endpoint}|${options.publicKey}`,
      endpoint,
      headers: { "x-langfuse-ingestion-version": "4" },
      resource: {
        serviceName: "cognia-ai",
        environment: options.environment || undefined,
        serviceVersion: options.release,
      },
      bufferSize: options.bufferSize,
      flushInterval: options.flushInterval,
      maxRetries: options.maxRetries,
      retryBaseMs: options.retryBaseMs,
      captureContent: false,
      spanContentPolicy: (span) => {
        if (span.operationName === "execute_tool") return options.captureToolContent
        if (
          span.operationName === "chat" ||
          span.operationName === "invoke_agent" ||
          span.operationName === "invoke_workflow"
        ) {
          return options.captureModelContent
        }
        return false
      },
      spanFilter: options.spanFilter,
      serializeBatch: (spans) => ({ schemaVersion: 1, spans }) satisfies AgentTraceBatchV1,
      deduplicateSpanIds: true,
      maxPreviewBytes: options.maxPreviewBytes,
      requestTimeoutMs: options.requestTimeoutMs,
      maxRequestBytes: options.maxRequestBytes,
      fetchImpl: createHostIngestFetch(options.hostIngest),
    }
    super(otlpOptions)
  }
}

function createHostIngestFetch(
  ingest: NonNullable<LangfuseTransportOptions["hostIngest"]>
): typeof fetch {
  return (async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("Langfuse Host batch is missing")
    const batch = JSON.parse(init.body) as AgentTraceBatchV1
    const result = await ingest(batch)
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      headers: { get: () => null },
    } as unknown as Response
  }) as typeof fetch
}

export function createLangfuseTransport(options: LangfuseTransportOptions): LangfuseTransport {
  return new LangfuseTransport(options)
}
