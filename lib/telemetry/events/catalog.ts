import type { BehaviorTelemetryCategory } from "./settings"

type AiSurface = "chat" | "agent-team" | "workflow" | "connector"

export interface TelemetryEventCatalog {
  "chat.message.sent": {
    sessionId: string
    provider: string
    surface: AiSurface
  }
  "chat.turn.completed": {
    sessionId: string
    provider: string
    surface: AiSurface
    durationMs?: number
  }
  "chat.turn.failed": {
    sessionId: string
    provider?: string
    surface: AiSurface
    errorType?: string
    durationMs?: number
  }
  "workflow.run.started": { runId: string; trigger: string }
  "workflow.run.completed": { runId: string; durationMs?: number }
  "workflow.run.failed": { runId: string; durationMs?: number; errorCode?: string }
  "workflow.run.cancelled": { runId: string; durationMs?: number }
  "connector.message.received": { adapterId: string; platform: string }
  "connector.message.sent": {
    adapterId: string
    platform: string
    outcome: "succeeded" | "failed"
    errorCode?: string
  }
  "agent.teammate.started": { runId: string; teamId: string; role: string }
  "agent.teammate.completed": {
    runId: string
    teamId: string
    channel: "text" | "sidecar" | "external"
    durationMs?: number
  }
  "agent.teammate.failed": {
    runId: string
    teamId: string
    errorType: string
    durationMs?: number
  }
  "telemetry.preference.changed": { enabled: boolean }
  /** ADR-0090 Phase 6: an authoritative resolver decision drove an execution. */
  "agent.execution.resolved": {
    surface: string
    runtime: string
    routeKind: string
    executionKind: string
    legacyMigrated: boolean
  }
  "support.session.opened": { sessionId: string }
  "support.diagnostics.consent.changed": {
    enabled: boolean
    surface: "chat" | "settings"
  }
  "support.feedback.draft.opened": {
    surface: "chat" | "mobile"
    sessionId?: string
  }
  "support.feedback.draft.exported": {
    surface: "chat" | "mobile"
    sessionId?: string
  }
}

export type TelemetryEventName = keyof TelemetryEventCatalog

export interface TelemetryEventDefinition {
  category: BehaviorTelemetryCategory
}

export const TELEMETRY_EVENT_CATALOG: Readonly<
  Record<TelemetryEventName, TelemetryEventDefinition>
> = {
  "chat.message.sent": { category: "chat" },
  "chat.turn.completed": { category: "chat" },
  "chat.turn.failed": { category: "chat" },
  "workflow.run.started": { category: "workflow" },
  "workflow.run.completed": { category: "workflow" },
  "workflow.run.failed": { category: "workflow" },
  "workflow.run.cancelled": { category: "workflow" },
  "connector.message.received": { category: "connector" },
  "connector.message.sent": { category: "connector" },
  "agent.teammate.started": { category: "agentTeam" },
  "agent.teammate.completed": { category: "agentTeam" },
  "agent.teammate.failed": { category: "agentTeam" },
  "telemetry.preference.changed": { category: "system" },
  "agent.execution.resolved": { category: "system" },
  "support.session.opened": { category: "system" },
  "support.diagnostics.consent.changed": { category: "system" },
  "support.feedback.draft.opened": { category: "system" },
  "support.feedback.draft.exported": { category: "system" },
}
