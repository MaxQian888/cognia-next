import type { HookInput } from "./kernel/types.ts"
import { HOOK_EVENTS } from "@anthropic-ai/claude-agent-sdk"

/**
 * Every lifecycle event the SDK can fire, taken from the SDK itself.
 *
 * This used to be a hand-written list of three, so the other 28 events could be
 * configured in settings.json and would simply never run — no error, no log,
 * just a hook that did nothing. Importing the SDK's own export means the list
 * cannot drift: a release that adds an event adds it here, and
 * `check:sdk-surface` fails if the manifest has not triaged it.
 */
export const SUPPORTED_EVENTS = HOOK_EVENTS

/**
 * Which field of a hook's input the `matcher` is tested against.
 *
 * Tool events match on the tool name; the rest each have their own natural
 * discriminator (a session's `source`, a compaction's `trigger`, a changed
 * file's path). An event absent from this map matches unconditionally —
 * correct for events with nothing to discriminate on, like `Stop`.
 */
export const HOOK_MATCH_FIELDS: Readonly<Record<string, string>> = {
  PreToolUse: "tool_name",
  PostToolUse: "tool_name",
  PostToolUseFailure: "tool_name",
  PermissionRequest: "tool_name",
  PermissionDenied: "tool_name",
  Notification: "notification_type",
  UserPromptExpansion: "command",
  SessionStart: "source",
  SessionEnd: "reason",
  Setup: "trigger",
  StopFailure: "error",
  PreCompact: "trigger",
  PostCompact: "trigger",
  SubagentStart: "agent_type",
  SubagentStop: "agent_type",
  FileChanged: "file_path",
  DirectoryAdded: "source",
  ConfigChange: "source",
  InstructionsLoaded: "load_reason",
  Elicitation: "mcp_server_name",
  ElicitationResult: "mcp_server_name",
}

export const HOOK_EVENTS_WITHOUT_MATCHERS = new Set([
  "UserPromptSubmit",
  "PostToolBatch",
  "Stop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "WorktreeCreate",
  "WorktreeRemove",
  "MessageDisplay",
  "CwdChanged",
  // These two are filtered by the SDK at registration, because only it knows
  // canonical provider/model aliases and the unknown-model fallback rule.
  "PreModelSwitch",
  "PostModelSwitch",
])

/**
 * The value a hook group's `matcher` is compared against for this event.
 *
 * Returns `null` when the event does not support matchers. Claude Code ignores
 * a configured matcher for those events and always runs the group.
 */
export function hookMatchTarget(eventName: string, input?: HookInput) {
  if (HOOK_EVENTS_WITHOUT_MATCHERS.has(eventName)) return null
  const field = HOOK_MATCH_FIELDS[eventName]
  if (!field) return null
  const value = input?.[field]
  return typeof value === "string" ? value : ""
}
