/**
 * The Claude Agent SDK's own tool names.
 *
 * `lib/settings/builtin-tools.ts` derives every tool this app contributes from
 * `builtin-tools-data.json`, but the SDK's native tools are not in that file
 * and cannot be derived from it. `lib/workspace/restricted-tools.ts` already
 * had to hand-list the mutating half for the same reason. This is that list
 * completed with the read-only half its doc comment names, kept in one place
 * so a picker and a policy cannot disagree about what the SDK offers.
 *
 * Not a closed set: a workflow may name a plugin tool the host has not loaded,
 * so every consumer keeps free entry.
 */

/** SDK tools that mutate disk or drive the host. */
export const SDK_NATIVE_MUTATING_TOOL_NAMES = [
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
] as const

/** SDK tools that only read. Safe in an untrusted workspace. */
export const SDK_NATIVE_READONLY_TOOL_NAMES = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
] as const

export const SDK_NATIVE_TOOL_NAMES: readonly string[] = [
  ...SDK_NATIVE_READONLY_TOOL_NAMES,
  ...SDK_NATIVE_MUTATING_TOOL_NAMES,
]
