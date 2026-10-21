// Structured payloads for slash-command system messages. Diagnostics commands
// (/context, /usage, /cost) emit one of these instead of a markdown string so
// the chat transcript can render a proper card (progress bars, badges) rather
// than a flat bullet list. `pushSystemMessage` accepts `string | SystemMessageBlock`
// and the message renderer dispatches blocks to `<DiagnosticsCard>` via a
// `data-diagnostics` UI message part.

import type {
  SlashCommandResultBlock,
  SystemMessageBlock,
} from "@cognia/plugin-contract/lib/slash-commands/system-blocks"
export type {
  ContextDiagnosticsBlock,
  CostDiagnosticsBlock,
  DiagnosticsWindow,
  SlashCommandResultBlock,
  SystemMessageBlock,
  UsageDiagnosticsBlock,
  UsageWindowStat,
} from "@cognia/plugin-contract/lib/slash-commands/system-blocks"

/** UI message part type carrying a {@link SystemMessageBlock}. */
export const DIAGNOSTICS_PART_TYPE = "data-diagnostics" as const

/** Narrowing guard for the renderer's `data-diagnostics` part. */
export function isSystemMessageBlock(value: unknown): value is SystemMessageBlock {
  if (!value || typeof value !== "object") return false
  const kind = (value as { kind?: unknown }).kind
  return kind === "context" || kind === "cost" || kind === "usage"
}

/** Narrowing guard for the slash-command result chip block. */
export function isSlashCommandResultBlock(value: unknown): value is SlashCommandResultBlock {
  if (!value || typeof value !== "object") return false
  return (value as { kind?: unknown }).kind === "slash-result"
}

/**
 * A video job started by `/video` (ADR-0205). The block holds only the job id;
 * the card reads the job's live row, so progress, cancel and the finished
 * video need no further message writes. Carried through the same
 * `data-diagnostics` part as the blocks above and rendered by `VideoJobView`.
 */
export interface VideoJobBlock {
  kind: "video-job"
  jobId: string
}

/** Narrowing guard for the `/video` job block. */
export function isVideoJobBlock(value: unknown): value is VideoJobBlock {
  if (!value || typeof value !== "object") return false
  const block = value as { kind?: unknown; jobId?: unknown }
  return block.kind === "video-job" && typeof block.jobId === "string" && block.jobId.length > 0
}

/**
 * A `!` line running as a supervised job (`lib/shell-intelligence/shell-job.ts`).
 * Rendered by `ShellJobView` from the live run, never from fields written per
 * chunk; the run rewrites this message into the result (or a "moved to the
 * background" note) when it is done with it. `sessionId` names the
 * conversation the job is filed under, so a reload can find it again.
 */
export interface ShellJobBlock {
  kind: "shell-job"
  jobId: string
  sessionId: string
  /** The line as typed, without the `!`. */
  command: string
  cwd: string
}

/** Narrowing guard for the `!` job block. */
export function isShellJobBlock(value: unknown): value is ShellJobBlock {
  if (!value || typeof value !== "object") return false
  const block = value as Partial<Record<keyof ShellJobBlock, unknown>>
  return (
    block.kind === "shell-job" &&
    typeof block.jobId === "string" &&
    block.jobId.length > 0 &&
    typeof block.sessionId === "string" &&
    block.sessionId.length > 0 &&
    typeof block.command === "string" &&
    typeof block.cwd === "string"
  )
}
