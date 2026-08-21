/**
 * CLI-side hook framework types. Mirrors the subset of the Claude Code hooks
 * schema (`settings.json` `hooks.{Event}` arrays) that the TUI supports, so a
 * user's existing `~/.claude/settings.json` round-trips into the CLI.
 *
 * Ported from `src-tauri/src/hooks/types.rs` (the desktop Rust implementation).
 * The string union mirrors the Rust `HookEvent` enum verbatim so classified
 * events line up across both shells.
 *
 * Reference: https://code.claude.com/docs/en/hooks
 */
import { z } from "zod"

/**
 * Hook lifecycle events. The full set is recognized so a settings.json `hooks`
 * fragment round-trips cleanly even for events the CLI doesn't itself fire.
 * Mirrors the Rust `HookEvent` enum (PascalCase wire names).
 */
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

/** Every recognized {@link HookEvent} name, for runtime validation. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "Setup",
  "SubagentStart",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PreCompact",
  "PostCompact",
  "TaskCreated",
  "TaskCompleted",
  "PermissionRequest",
  "PermissionDenied",
  "WorktreeCreate",
  "WorktreeRemove",
  "FileChanged",
  "DirectoryAdded",
  "CwdChanged",
  "InstructionsLoaded",
  "ConfigChange",
  "Elicitation",
  "ElicitationResult",
  "PostToolBatch",
  "PostToolUseFailure",
  "StopFailure",
  "TeammateIdle",
  "UserPromptExpansion",
  "MessageDisplay",
]

/**
 * A single handler entry inside a {@link HookGroup}.
 *
 * - `command` — spawn a shell command with the JSON event payload on stdin.
 * - `webhook` — HTTP POST the payload as JSON (recognized, inert in the core).
 * - any other `type` — recognized so settings.json round-trips, but inert
 *   (MCP-tool / prompt / agent handlers etc. that the CLI doesn't execute).
 */
export type HookHandler =
  | { type: "command"; command: string; timeout?: number }
  | { type: "webhook"; url: string; headers?: Record<string, string>; timeout?: number }
  | { type: "http"; url: string; headers?: Record<string, string>; timeout?: number }
  /**
   * Plugin handler. Recognised so settings.json round-trips, but INERT on this
   * rail: it needs the renderer round-trip only the sidecar performs. A CLI
   * turn gets it anyway, because the CLI injects its config into
   * `sendOptions.hooks` and the sidecar runs it there.
   */
  | { type: "plugin"; pluginId: string; hookId: string; timeout?: number }
  | ({ type: string } & Record<string, unknown>)

/** One hook block in a `settings.json` `hooks.{Event}` array. */
export interface HookGroup {
  /** Tool-name regex (or comma-separated literal list). Omitted = match all. */
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
  /** Handlers run sequentially; the first blocking command handler wins. */
  hooks: HookHandler[]
}

/** A parsed hooks configuration: per-event arrays of {@link HookGroup}. */
export type HooksConfig = Partial<Record<HookEvent, HookGroup[]>>

/**
 * Zod schema for a single handler. Known `command` / `webhook` shapes are
 * validated; any other `type` is tolerated via `passthrough()` so unknown
 * handler kinds survive a round-trip (and are treated as inert at run time).
 */
const commandHandlerSchema = z
  .object({
    type: z.literal("command"),
    command: z.string(),
    timeout: z.number().optional(),
  })
  .passthrough()

const webhookHandlerSchema = z
  .object({
    type: z.literal("webhook"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().optional(),
  })
  .passthrough()

const httpHandlerSchema = z
  .object({
    type: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    timeout: z.number().optional(),
  })
  .passthrough()
/** Unknown handler `type` — preserved verbatim, inert at run time. */
const otherHandlerSchema = z.object({ type: z.string() }).passthrough()

const hookHandlerSchema: z.ZodType<HookHandler> = z.union([
  commandHandlerSchema,
  webhookHandlerSchema,
  httpHandlerSchema,
  otherHandlerSchema,
]) as z.ZodType<HookHandler>

/** Zod schema for one {@link HookGroup}. */
export const hookGroupSchema: z.ZodType<HookGroup> = z
  .object({
    matcher: z.string().optional(),
    agents: z.string().optional(),
    hooks: z.array(hookHandlerSchema),
  })
  .passthrough() as unknown as z.ZodType<HookGroup>

/**
 * Zod schema for a whole hooks config: a partial map of {@link HookEvent} →
 * group array. Unknown event keys are tolerated (`passthrough`) so a richer
 * future settings.json doesn't fail validation; only the known events are
 * surfaced typed.
 */
export const HooksConfigSchema: z.ZodType<HooksConfig> = z
  .object(
    HOOK_EVENTS.reduce<Record<string, z.ZodTypeAny>>((acc, ev) => {
      acc[ev] = z.array(hookGroupSchema).optional()
      return acc
    }, {})
  )
  .passthrough() as unknown as z.ZodType<HooksConfig>
