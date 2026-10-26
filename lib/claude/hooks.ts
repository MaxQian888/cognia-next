// Frontend hook configuration types mirror `crates/cognia-hooks/src/types.rs`.
// Claude SDK hooks execute in the sidecar; host adapters use the native rail.
// Both share these settings and the event catalog used by the settings UI.

export type {
  HookEvent,
  HookGroup,
  HookHandler,
  HookShell,
  HooksConfig,
} from "@cognia/plugin-contract/lib/claude/hooks"

export type HookHandlerType = "command" | "http" | "mcp_tool" | "prompt" | "agent" | "plugin"
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
  "asyncRewake",
  "shell",
  "allowedEnvVars",
]

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
