/**
 * Presentation requests a runtime extension makes (status lines, widgets,
 * title, editor text, notifications), independent of runtime and frontend.
 * Shared by the canonical event stream and the external-agent event stream.
 */
export type AgentExtensionUiUpdate =
  | { kind: "status"; key: string; text: string | null }
  | {
      kind: "widget"
      key: string
      lines: string[] | null
      placement: "aboveEditor" | "belowEditor"
    }
  | { kind: "title"; title: string }
  | { kind: "editor"; text: string }
  | {
      kind: "notification"
      level: "info" | "warning" | "error"
      message: string
      /** Preserve a runtime's open severity vocabulary without inventing urgency. */
      sourceSeverity?: string
    }
