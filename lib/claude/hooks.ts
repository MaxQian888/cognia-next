// Frontend type defs mirroring `src-tauri/src/hooks/types.rs`. The hook
// runtime lives entirely in Rust — these are surface types for UI consumers
// (e.g. the future hooks settings tab) that need to read or render the hook
// config block from settings.json.

/** Claude Agent SDK 0.3.220 lifecycle events. */
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

export type HookHandlerType = "command" | "http" | "mcp_tool" | "prompt" | "agent" | "plugin"
export type HookShell = "bash" | "powershell"

/**
 * Closed vocabulary for *which* agent a lifecycle event came from.
 *
 * Before this existed, a teammate turn, a plan step, a connector auto-reply and
 * a plain user chat all produced indistinguishable hook payloads — the only
 * identity a hook ever saw was `session_id`. The SDK's own `agent_type` /
 * `agent_id` only populate inside SDK-Task subagents, so they cannot carry a
 * cognia-side identity (see `sidecar/dispatch/agent-hooks.mjs`).
 *
 * Kept closed (rather than a free string) so the `HookGroup.agents` selector has
 * a validatable domain the settings UI can enumerate. Free-form detail — a
 * teammate id, a subagent definition id — belongs in the companion `agent_ref`.
 */
export type HookAgentKind =
  | "chat"
  | "teammate"
  | "subagent"
  | "goal-judge"
  | "plan-step"
  | "connector"
  | "scheduler"
  | "external"
  | "system"

/** Every member of {@link HookAgentKind}, for validation and UI enumeration. */
export const HOOK_AGENT_KINDS: readonly HookAgentKind[] = [
  "chat",
  "teammate",
  "subagent",
  "goal-judge",
  "plan-step",
  "connector",
  "scheduler",
  "external",
  "system",
]

/** True when `value` is a recognised {@link HookAgentKind}. */
export function isHookAgentKind(value: string): value is HookAgentKind {
  return (HOOK_AGENT_KINDS as readonly string[]).includes(value)
}

/**
 * Handler fields that round-trip through `settings.json` but that NO runner
 * executes — not the sidecar, not the Rust host, not the CLI.
 *
 * They are kept (rather than deleted) because they are part of the upstream
 * Claude Code settings vocabulary and this repo's own `.claude/settings.json`
 * uses `args`; removing them would strip type support from a file Claude Code
 * itself reads. Declared here so the type, the settings UI and a test all say
 * the same thing — the three-axis rule for intentional dormancy.
 *
 * Adding one of these to a runner means removing it from this list; the test in
 * `hooks.test.ts` fails otherwise.
 */
export const DORMANT_HOOK_HANDLER_FIELDS: readonly string[] = [
  "args",
  "if",
  "statusMessage",
  "once",
  "async",
  "asyncRewake",
  "shell",
  "allowedEnvVars",
]

interface HookHandlerCommon {
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
      /** DORMANT — see {@link DORMANT_HOOK_HANDLER_FIELDS}. */
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
