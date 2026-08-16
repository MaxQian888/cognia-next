import type { SupportReportSurface } from "@/lib/support-report/types"

import type { BehaviorTelemetryCategory } from "./settings"

type AiSurface = "chat" | "agent-team" | "workflow" | "connector"

/** The section kinds a conversation-list row can live in — the prefix of `conversationSectionKey`. */
export type ConversationListSectionKind =
  "pinned" | "folder" | "date" | "recent" | "workspace" | "agent" | "search"

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
  // --- Conversation list (desktop sidebar + mobile list) -------------------
  // Attribute values are ids and enums only: never a title, a query string, a
  // folder / preset name or anything else the user typed.
  /** A conversation was activated from the list. */
  "chat.list.opened": {
    sessionId: string
    /** How it was activated: a row click, Enter on the focused row, or the branch-lineage chip. */
    via: "click" | "keyboard" | "parent-link"
  }
  /** A new conversation was started from the list's primary action. */
  "chat.list.created": { kind: "direct" | "team" }
  /** A (debounced) search query produced results. Carries the query *length*, never its text. */
  "chat.list.searched": {
    scope: "title" | "titleAndContent"
    queryLength: number
    resultCount: number
    /** True when the content index reported more history than it searched. */
    truncated: boolean
  }
  /** A row was dragged to a new position inside a section. */
  "chat.list.reordered": {
    section: ConversationListSectionKind
    from: number
    to: number
    size: number
    via: "pointer" | "keyboard"
  }
  /** A per-row or bulk action from the row menu / selection toolbar. */
  "chat.list.row.action": {
    action:
      | "pin"
      | "unpin"
      | "archive"
      | "unarchive"
      | "delete"
      | "rename"
      | "assign-folder"
      | "unassign-folder"
      // Opening the multi-conversation share dialog from the selection
      // toolbar. Reported when the dialog is requested, not when a link is
      // minted — the share subsystem owns that half (ADR-0037).
      | "share"
    /** Rows affected — 1 for a row action, the selection size for a bulk one. */
    count: number
    bulk: boolean
  }
  /** A display / ordering knob in the list's view menu changed. */
  "chat.list.layout.changed": {
    setting: string
    /** Enum / boolean rendered as a string; array-valued settings report their size. */
    value: string
  }
  /** Active ⇄ archived switch. */
  "chat.list.view.changed": { view: "active" | "archived" }
  /** A folder or workspace / agent group was folded or unfolded. */
  "chat.list.section.toggled": { section: ConversationListSectionKind; collapsed: boolean }
  /** A quick filter changed. `facet` names the control, `activeCount` the filters now narrowing the list. */
  "chat.list.filtered": {
    facet: string
    activeCount: number
  }
  "voice.connection.ready": { provider: string; durationMs: number }
  "voice.first-audio": { provider: string; eouToAudioMs: number }
  "voice.interrupted": { provider: string; playedMs: number }
  "voice.reconnect": {
    provider: string
    attempt: number
    outcome: "started" | "succeeded" | "failed"
  }
  "voice.tool.completed": {
    provider: string
    status: string
    durationMs: number
  }
  "voice.error": { provider: string; code: string }
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
  /** Resolver-v2 observation while the legacy rail still owns execution. */
  "agent.execution.shadow": {
    runtimeAdapter: string
    executionKind: string
    routeKind: string
    missingRequiredCount: number
    compatibilityEvidence: string
  }
  "support.session.opened": { sessionId: string }
  "support.diagnostics.consent.changed": {
    enabled: boolean
    surface: "chat" | "settings"
  }
  "support.feedback.draft.opened": {
    surface: SupportReportSurface
    sessionId?: string
  }
  "support.feedback.draft.exported": {
    surface: SupportReportSurface
    channel: string
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
  "chat.list.opened": { category: "chat" },
  "chat.list.created": { category: "chat" },
  "chat.list.searched": { category: "chat" },
  "chat.list.reordered": { category: "chat" },
  "chat.list.row.action": { category: "chat" },
  "chat.list.layout.changed": { category: "chat" },
  "chat.list.view.changed": { category: "chat" },
  "chat.list.section.toggled": { category: "chat" },
  "chat.list.filtered": { category: "chat" },
  "voice.connection.ready": { category: "chat" },
  "voice.first-audio": { category: "chat" },
  "voice.interrupted": { category: "chat" },
  "voice.reconnect": { category: "chat" },
  "voice.tool.completed": { category: "chat" },
  "voice.error": { category: "chat" },
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
  "agent.execution.shadow": { category: "system" },
  "support.session.opened": { category: "system" },
  "support.diagnostics.consent.changed": { category: "system" },
  "support.feedback.draft.opened": { category: "system" },
  "support.feedback.draft.exported": { category: "system" },
}
