// Frontend type defs mirroring `src-tauri/src/hooks/types.rs`. The hook
// runtime lives entirely in Rust — these are surface types for UI consumers
// (e.g. the future hooks settings tab) that need to read or render the hook
// config block from settings.json.

/** Hook lifecycle events. Phase 1 wires `UserPromptSubmit` and `PreToolUse`. */
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

export type HookHandler =
  | { type: "command"; command: string; timeout?: number }
  | {
      type: "webhook"
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
