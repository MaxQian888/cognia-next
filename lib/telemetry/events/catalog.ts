export interface TelemetryEventCatalog {
  "chat.message.sent": {
    sessionId: string
    provider: string
    surface: "chat" | "agent-team" | "workflow" | "connector"
  }
  "workflow.run.started": { workflowId: string; source: "manual" | "scheduled" | "webhook" }
  "connector.message.received": { adapterId: string; platform: string }
  "telemetry.preference.changed": { enabled: boolean }
}

export type TelemetryEventName = keyof TelemetryEventCatalog

export const TELEMETRY_EVENT_CATALOG: Readonly<Record<TelemetryEventName, true>> = {
  "chat.message.sent": true,
  "workflow.run.started": true,
  "connector.message.received": true,
  "telemetry.preference.changed": true,
}
