// Trace context from the renderer, and the per-call AI SDK telemetry options.

import { ROOT_CONTEXT, context, propagation } from "@opentelemetry/api"
import type { Context } from "@opentelemetry/api"

import { telemetrySession } from "./state.ts"

/** The context a W3C `traceparent` names, or the root context when there is none. */
export function parentContext(traceparent: unknown): Context {
  if (typeof traceparent !== "string" || traceparent.length === 0) return ROOT_CONTEXT
  return propagation.extract(ROOT_CONTEXT, { traceparent })
}

/** Run `callback` with the renderer's span as the active parent. */
export function withTraceparent<T>(traceparent: unknown, callback: () => T): T {
  return context.with(parentContext(traceparent), callback)
}

/** Correlation ids a model call carries into its spans; values come off the wire unchecked. */
export interface AiSdkTelemetryInput {
  sessionId?: unknown
  traceId?: unknown
  surface?: unknown
  runId?: unknown
  turnId?: unknown
  attemptId?: unknown
  projectId?: unknown
  feature?: unknown
  promptComponentIds?: unknown
  promptVersion?: unknown
  promptFingerprint?: unknown
  provider?: unknown
  traceparent?: unknown
}

export interface AiSdkTelemetryOptions {
  functionId: string
  runtimeContext: Record<string, unknown>
  includeRuntimeContext: Record<string, true>
  recordInputs: boolean
  recordOutputs: boolean
  traceparent: unknown
}

/** The AI SDK `telemetry` option for one call, or undefined while telemetry is off. */
export function aiSdkTelemetry({
  sessionId,
  traceId,
  surface,
  runId,
  turnId,
  attemptId,
  projectId,
  feature,
  promptComponentIds,
  promptVersion,
  promptFingerprint,
  provider,
  traceparent,
}: AiSdkTelemetryInput): AiSdkTelemetryOptions | undefined {
  if (!telemetrySession.sdk) return undefined
  const { model, tool } = telemetrySession.consent
  const runtimeContext = Object.fromEntries(
    Object.entries({
      cogniaSessionId: sessionId,
      cogniaTraceId: traceId,
      cogniaSurface: surface,
      cogniaRunId: runId,
      cogniaTurnId: turnId,
      cogniaAttemptId: attemptId,
      cogniaProjectId: projectId,
      cogniaFeature: feature,
      cogniaPromptComponentIds: promptComponentIds,
      cogniaPromptVersion: promptVersion,
      cogniaPromptFingerprint: promptFingerprint,
    }).filter(([, value]) => value !== undefined)
  )
  return {
    // `isEnabled: true` is gone: in v7 telemetry is on by default once an
    // integration is registered, and `initializeTelemetry` only registers when
    // at least one trace destination exists. `tracer` is gone too — v7 removed
    // it from the per-call options; the custom tracer now lives on the
    // integration built at process startup.
    functionId: `cognia.sidecar.${provider || "unknown"}`,
    runtimeContext,
    includeRuntimeContext: Object.fromEntries(
      Object.keys(runtimeContext).map((key): [string, true] => [key, true])
    ),
    // Content enters spans only when either explicit Langfuse consent is on.
    // Destination processors still enforce model/tool consent independently;
    // generic OTLP and PostHog always strip content.
    recordInputs: model || tool,
    recordOutputs: model || tool,
    traceparent,
  }
}
