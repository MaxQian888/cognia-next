/**
 * Context builder for the AI Shell.
 *
 * Assembles a snapshot of the terminal's current state (CWD, shell, recent
 * output, git branch, command history) into an `AiShellContext` that the
 * plan generator uses to ground its responses.
 *
 * All context passes through the PII gate before being handed to the LLM,
 * ensuring no credentials or secrets leak. The gate is injected so tests
 * can deterministically control the filter without mocking the module.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import type { AiShellContext } from "./types"
import type { TerminalSessionRow, TerminalCommandRecord } from "@/stores/terminal/terminal-store"

/** Maximum lines of recent output to include. */
export const MAX_RECENT_OUTPUT_LINES = 50

/** Maximum recent commands to include. */
export const MAX_RECENT_COMMANDS = 10

/** Maximum characters per output line (truncate overly long lines). */
export const MAX_LINE_LENGTH = 500

/** Dependencies injected for testability. */
export interface ContextBuilderDeps {
  /** PII safety gate. Defaults to `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
}

/**
 * Build the AI Shell context from the terminal state.
 *
 * @param row - The terminal session row from the store
 * @param recentOutput - Raw terminal output (last N lines as a single string)
 * @param opts - Optional overrides for platform / git branch detection
 */
export function buildAiShellContext(
  row: Pick<TerminalSessionRow, "cwd" | "shell" | "lastCommands">,
  recentOutput: string,
  opts?: {
    gitBranch?: string | null
    platform?: string
  }
): AiShellContext {
  const commands = extractRecentCommands(row.lastCommands)
  const truncatedOutput = truncateOutput(recentOutput)

  return {
    cwd: row.cwd,
    shell: row.shell,
    gitBranch: opts?.gitBranch ?? null,
    recentOutput: truncatedOutput,
    recentCommands: commands,
    platform: opts?.platform ?? detectPlatform(),
  }
}

/**
 * Check if the assembled context is safe to send to an LLM.
 * Returns false if any part contains PII / secrets.
 */
export function isContextPiiSafe(ctx: AiShellContext, deps?: ContextBuilderDeps): boolean {
  const gate = deps?.isPiiSafe ?? hasNoLeakingPii
  // Check each context section individually for finer error reporting
  const sections = [ctx.cwd ?? "", ctx.recentOutput, ...ctx.recentCommands]
  return sections.every((section) => section === "" || gate(section))
}

/**
 * Assemble the full text payload that will be sent to the LLM (for PII
 * checking the combined result rather than individual sections).
 */
export function serializeContextForPiiCheck(ctx: AiShellContext): string {
  const parts: string[] = []
  if (ctx.cwd) parts.push(`CWD: ${ctx.cwd}`)
  parts.push(`Shell: ${ctx.shell}`)
  if (ctx.gitBranch) parts.push(`Branch: ${ctx.gitBranch}`)
  if (ctx.recentOutput) parts.push(`Output:\n${ctx.recentOutput}`)
  if (ctx.recentCommands.length > 0) {
    parts.push(`History:\n${ctx.recentCommands.join("\n")}`)
  }
  return parts.join("\n")
}

/** Extract the command strings from the last N TerminalCommandRecords. */
function extractRecentCommands(records: TerminalCommandRecord[]): string[] {
  return records
    .slice(-MAX_RECENT_COMMANDS)
    .map((r) => r.cmd)
    .filter((cmd) => cmd.length > 0)
}

/** Truncate output to MAX_RECENT_OUTPUT_LINES, each capped at MAX_LINE_LENGTH. */
function truncateOutput(raw: string): string {
  if (!raw) return ""
  const lines = raw.split("\n")
  const tail = lines.slice(-MAX_RECENT_OUTPUT_LINES)
  return tail
    .map((line) => (line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "…" : line))
    .join("\n")
}

/** Detect the platform from globalThis or navigator. */
function detectPlatform(): string {
  if (typeof globalThis !== "undefined" && "process" in globalThis) {
    // Node / Tauri environment
    const proc = globalThis as unknown as { process?: { platform?: string } }
    return proc.process?.platform ?? "unknown"
  }
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase()
    if (ua.includes("mac")) return "darwin"
    if (ua.includes("win")) return "win32"
    if (ua.includes("linux")) return "linux"
  }
  return "unknown"
}
