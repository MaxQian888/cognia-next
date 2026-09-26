// The one telemetry session a sidecar process runs: set by
// `initializeTelemetry`, cleared by `shutdownTelemetry`, and read by the span
// processors and the per-call AI SDK options.

import type { NodeSDK } from "@opentelemetry/sdk-node"

/** Which content classes the user allowed Langfuse to record. Generic OTLP and PostHog never record content. */
export interface ContentConsent {
  model: boolean
  tool: boolean
}

export interface TelemetrySession {
  /** The running SDK; null means no destination is configured and telemetry is silent. */
  sdk: NodeSDK | null
  installationId: string
  consent: ContentConsent
}

export const telemetrySession: TelemetrySession = {
  sdk: null,
  installationId: "",
  consent: { model: false, tool: false },
}
