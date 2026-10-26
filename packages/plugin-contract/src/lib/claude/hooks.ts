/**
 * The plugin contract's share of `lib/claude/hooks.ts`, which re-exports these.
 */
/** Claude Agent SDK 0.3.269 lifecycle events. */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "Setup"
  | "SubagentStart"
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
  | "DirectoryAdded"
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
  | "MessageDisplay"
  | "PreModelSwitch"
  | "PostModelSwitch"

export type HookShell = "bash" | "powershell"

export interface HookHandlerCommon {
  /**
   * Permission-rule filter supported by native Claude tool events.
   * DORMANT — no runner evaluates it. See {@link DORMANT_HOOK_HANDLER_FIELDS}.
   */
  if?: string
  /** Timeout in seconds, matching the upstream settings.json contract. */
  timeout?: number
  /** DORMANT — see {@link DORMANT_HOOK_HANDLER_FIELDS}. */
  statusMessage?: string
  /** DORMANT — see {@link DORMANT_HOOK_HANDLER_FIELDS}. */
  once?: boolean
  /**
   * Cognia-managed policy hooks fail closed; user-authored hooks fail open.
   * Honoured on the sidecar rail (`sidecar/dispatch/agent-hooks.mjs`).
   */
  policyClass?: "user" | "managed"
}

export type HookHandler =
  | (HookHandlerCommon & {
      type: "command"
      command: string
      /** DORMANT — see {@link DORMANT_HOOK_HANDLER_FIELDS}. */
      args?: string[]
      /**
       * Fire-and-forget: the runner spawns the command detached, pipes the
       * payload on stdin, and never waits for exit. The process may outlive
       * the turn; its output can neither block nor inject context, so an
       * `async` handler never denies a tool call. Honoured on every rail
       * (sidecar, Rust, CLI).
       */
      async?: boolean
      /** DORMANT — see {@link DORMANT_HOOK_HANDLER_FIELDS}. */
      asyncRewake?: boolean
      /** DORMANT — see {@link DORMANT_HOOK_HANDLER_FIELDS}. */
      shell?: HookShell
    })
  | {
      /** Legacy Cognia alias. Writers should migrate this to `http`. */
      type: "webhook"
      url: string
      headers?: Record<string, string>
      /** DORMANT — see {@link DORMANT_HOOK_HANDLER_FIELDS}. */
      allowedEnvVars?: string[]
      timeout?: number
      policyClass?: "user" | "managed"
    }
  | (HookHandlerCommon & {
      type: "http"
      url: string
      headers?: Record<string, string>
      /** DORMANT — see {@link DORMANT_HOOK_HANDLER_FIELDS}. */
      allowedEnvVars?: string[]
    })
  | (HookHandlerCommon & {
      type: "mcp_tool"
      server: string
      tool: string
      input?: Record<string, unknown>
    })
  | (HookHandlerCommon & {
      type: "prompt" | "agent"
      prompt: string
      model?: string
    })
  | (HookHandlerCommon & {
      /**
       * Run an installed plugin's in-process hook handler.
       *
       * Two independent gates gate this: writing it here is the USER's
       * authorization, and the plugin's own `hooks:chat-intercept` capability
       * is the PLUGIN's — the latter only required when bound to an event that
       * can deny a turn. Fails OPEN on every other failure (absent plugin,
       * disabled plugin, missing hook, timeout).
       *
       * Sidecar rail only: it round-trips through the renderer
       * (`sidecar/dispatch/plugin-hook-exec.mjs`), which the Rust host and the
       * CLI's fallback runner cannot do.
       */
      type: "plugin"
      pluginId: string
      /** The plugin hook name, e.g. `"onPreToolUse"`. */
      hookId: string
    })

export interface HookGroup {
  /** Tool-name regex, pipe-list, or `"*"`. Omitted = match all. */
  matcher?: string
  /**
   * Agent selector, orthogonal to {@link matcher}: same syntax, tested against
   * the event's `agent_kind` and `agent_ref`. Omitted = match every agent.
   *
   * A cognia extension to the settings.json vocabulary. Real Claude Code reads
   * the same file and ignores the unknown key, so a group narrowed here runs
   * UNCONDITIONALLY there — the settings UI states this explicitly.
   */
  agents?: string
  hooks: HookHandler[]
}

/** Shape of the `hooks` block in `settings.json`. */
export type HooksConfig = Partial<Record<HookEvent, HookGroup[]>>
