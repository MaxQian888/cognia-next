// Sidecar OpenTelemetry. With no destination configured (no OTLP endpoint,
// PostHog destination, or Langfuse credentials) it stays completely silent:
// no SDK, no AI SDK integration, no spans. Spans that do leave the process go
// through the privacy filters in ./privacy.ts (OTLP, PostHog) or
// ./langfuse.ts (Langfuse, with the user's content consent).

import { trace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { PostHogTraceExporter } from "@posthog/ai/otel"

import { langfuseTracingEnabled, parseHeaders, parsePostHogDestinations } from "./config.ts"
import type { TelemetryEnv } from "./config.ts"
import { CogniaCorrelationSpanProcessor } from "./correlation.ts"
import { LazyLangfuseSpanProcessor, scrubLangfuseSecretEnvironment } from "./langfuse.ts"
import { PrivacyFilteringSpanExporter } from "./privacy.ts"
import { telemetrySession } from "./state.ts"

export { aiSdkTelemetry, parentContext, withTraceparent } from "./trace.ts"
export { traceAsyncIterable } from "./local-spans.ts"

/**
 * AI SDK 7 moved OpenTelemetry span collection out of the `ai` package: it no
 * longer emits spans just because a call passes telemetry options. The
 * integration is registered once, PROCESS-WIDE, from Langfuse's official
 * AI SDK 7 integration.
 *
 * Registration is deliberately tied to the SDK being live: v7 telemetry is
 * opt-OUT once an integration exists, so registering with no OTLP endpoint
 * configured would start producing spans in a process that has no exporter —
 * the opposite of the current "no endpoint means completely silent" behaviour.
 */
let aiTelemetryRegistered = false

/**
 * Register before the first request; a duplicate process-global integration
 * would produce duplicate generation and tool observations.
 *
 * `ai` and `@langfuse/vercel-ai-sdk` are loaded LAZILY, and the Langfuse
 * integration is a sidecar-only dependency (it is not in the root manifest, and
 * it pulls in ESM-only `@ai-sdk/otel`). A static import would make this module
 * unloadable anywhere but the sidecar process, and would put both on the cold
 * start of every rail that imports the AI SDK adapter.
 *
 * A failed load therefore means "not the sidecar process", where collecting AI
 * SDK spans would be meaningless anyway: swallow it and leave telemetry
 * unregistered. `initializeTelemetry` still reports success, because the OTLP
 * exporter itself (the part this process does own) did start.
 *
 * The import settles on a microtask, long before the first model call, which
 * only happens after the IPC handshake.
 */
function registerAiSdkTelemetry(): void {
  if (aiTelemetryRegistered) return
  // Set before awaiting so two calls in the same tick can't both register —
  // `registerTelemetry` appends to a process-global list and a duplicate would
  // double every span.
  aiTelemetryRegistered = true
  Promise.all([import("ai"), import("@langfuse/vercel-ai-sdk")])
    .then(([{ registerTelemetry }, { LangfuseVercelAiSdkIntegration }]) => {
      registerTelemetry(
        new LangfuseVercelAiSdkIntegration({
          tracer: trace.getTracer("cognia.sidecar.ai-sdk"),
        })
      )
    })
    .catch(() => {
      // Not the sidecar process (or the packages are absent) — allow a later
      // init to try again rather than latching the failure.
      aiTelemetryRegistered = false
    })
}

/**
 * Start the process's telemetry from the host-provided env. Returns false,
 * doing nothing, when no destination is configured or telemetry already runs.
 */
export function initializeTelemetry(env: TelemetryEnv = process.env): boolean {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  const posthogDestinations = parsePostHogDestinations(env.COGNIA_POSTHOG_DESTINATIONS_JSON)
  const langfuseEnabled = langfuseTracingEnabled(env)
  if ((!endpoint && posthogDestinations.length === 0 && !langfuseEnabled) || telemetrySession.sdk) {
    return false
  }
  telemetrySession.installationId = String(env.COGNIA_OBSERVABILITY_INSTALLATION_ID ?? "").trim()
  telemetrySession.consent = {
    model: env.COGNIA_LANGFUSE_CAPTURE_MODEL_CONTENT === "true",
    tool: env.COGNIA_LANGFUSE_CAPTURE_TOOL_CONTENT === "true",
  }
  const spanProcessors: SpanProcessor[] = [new CogniaCorrelationSpanProcessor()]
  if (endpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new PrivacyFilteringSpanExporter(
          new OTLPTraceExporter({
            url: endpoint,
            headers: parseHeaders(
              env.OTEL_EXPORTER_OTLP_HEADERS,
              env.COGNIA_OTEL_EXPORTER_HEADERS_JSON
            ),
          })
        ),
        { maxExportBatchSize: 16 }
      )
    )
  }
  for (const destination of posthogDestinations) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new PrivacyFilteringSpanExporter(
          new PostHogTraceExporter({
            projectToken: destination.projectToken,
            host: destination.host,
          })
        ),
        { maxExportBatchSize: 16 }
      )
    )
  }
  if (langfuseEnabled) spanProcessors.push(new LazyLangfuseSpanProcessor(env))
  scrubLangfuseSecretEnvironment(env)
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME || "cognia-sidecar",
    spanProcessors,
  })
  telemetrySession.sdk = sdk
  sdk.start()
  registerAiSdkTelemetry()
  return true
}

/** Flush and stop the SDK, and forget the session's installation id and consent. */
export async function shutdownTelemetry(): Promise<void> {
  const current = telemetrySession.sdk
  telemetrySession.sdk = null
  telemetrySession.installationId = ""
  telemetrySession.consent = { model: false, tool: false }
  if (current) await current.shutdown()
}
