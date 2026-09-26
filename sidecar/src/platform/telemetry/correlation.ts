import type { AttributeValue } from "@opentelemetry/api"
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base"

import { boundedAttributeValue } from "./privacy.ts"
import { telemetrySession } from "./state.ts"

const LANGFUSE_METADATA_PREFIX = "langfuse.observation.metadata."

/**
 * Keep Cognia correlation attributes independent from any single AI SDK
 * integration. Langfuse's official integration records runtime context as
 * observation metadata; this processor mirrors the small, non-content subset
 * that generic OTLP and PostHog already relied on.
 */
export class CogniaCorrelationSpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const metadata = (key: string): unknown =>
      span.attributes?.[`${LANGFUSE_METADATA_PREFIX}${key}`]
    const mapped = {
      "gen_ai.conversation.id": metadata("cogniaSessionId"),
      "cognia.trace_id": metadata("cogniaTraceId"),
      "cognia.surface": metadata("cogniaSurface"),
      "cognia.run.id": metadata("cogniaRunId"),
      "cognia.turn.id": metadata("cogniaTurnId"),
      "cognia.attempt.id": metadata("cogniaAttemptId"),
      "cognia.project.id": metadata("cogniaProjectId"),
    }
    for (const [key, value] of Object.entries(mapped)) {
      const bounded = boundedAttributeValue(value)
      // The metadata values are span attributes already; bounding keeps their shape.
      if (bounded !== undefined) span.setAttribute(key, bounded as AttributeValue)
    }
    const { installationId } = telemetrySession
    if (installationId) span.setAttribute("posthog.distinct_id", installationId.slice(0, 512))
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}
