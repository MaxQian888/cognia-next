// Frontend type defs mirroring `src-tauri/src/hooks/types.rs`. The hook
// runtime lives entirely in Rust — these are surface types for UI consumers
// (e.g. the future hooks settings tab) that need to read or render the hook
// config block from settings.json.

/** Hook lifecycle events exposed by the pinned Claude Agent SDK. */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "SessionStart"
  | "SessionEnd"
  | "Notification"
  | "PreCompact"
  | "PostCompact"
  | "TaskCreated"
  | "TaskCompleted"
  | "PermissionRequest"
  | "PermissionDenied"
  | "WorktreeCreate"
  | "WorktreeRemove"
  | "FileChanged"
  | "CwdChanged"
  | "InstructionsLoaded"
  | "ConfigChange"
  | "Elicitation"
  | "ElicitationResult"
  | "PostToolBatch"
  | "PostToolUseFailure"
  | "StopFailure"
  | "TeammateIdle"
  | "UserPromptExpansion"
  | "Setup"
  | "SubagentStart"
  | "DirectoryAdded"
  | "MessageDisplay"

export type HookHandler =
  | { type: "command"; command: string; timeout?: number }
  | {
      type: "webhook"
      url: string
      headers?: Record<string, string>
      timeout?: number
    }
  | {
      type: "http"
      url: string
      headers?: Record<string, string>
      timeout?: number
    }

export interface HookGroup {
  /** Tool-name regex, pipe-list, or `"*"`. Omitted = match all. */
  matcher?: string
  hooks: HookHandler[]
}

/** Shape of the `hooks` block in `settings.json`. */
export type HooksConfig = Partial<Record<HookEvent, HookGroup[]>>

/**
 * Structured payload for the synthetic `hook-notice` message part / marker.
 * Canonical home for the type so both the adapter that builds it
 * (`lib/claude/adapter.ts`) and the renderer that displays it
 * (`components/chat/message-parts/hook-notice-part.tsx`) share one definition.
 * Lives here (a zero-import module) to avoid pulling the adapter into the
 * client bundle through the renderer.
 */
export interface HookNoticePartData {
  type: "hook-notice"
  /** Lifecycle event name, e.g. "PreToolUse" / "UserPromptSubmit". */
  event: string
  /** Tool the hook gated, when the event is tool-scoped. */
  toolName?: string
  /** Derived status, by precedence block > context > warning. */
  outcome: "blocked" | "context" | "warning"
  /** Reason a hook blocked the action. */
  block?: string
  /** Context a hook injected into the turn. */
  additionalContext?: string
  /** Non-blocking diagnostics (timeouts, crashes). */
  warnings: string[]
}
