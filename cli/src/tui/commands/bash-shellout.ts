/**
 * Pure helpers for the `!command` shell-out (Claude-Code style). A leading `!`
 * on the submitted line runs the rest as a local shell command and shows the
 * output as a cell — no model round-trip. The actual spawn lives in
 * `agent/run-shell.ts` (injectable); this module is the pure parse + format.
 */
import { CLI_BASH_ANALYSIS_PROMPT } from "@/lib/agent/prompts/cli-prompts"
import { resolvePrompt } from "@/lib/prompts/resolve"
import type { PromptResolutionContext } from "@/lib/prompts/types"
import type { ShellResult } from "../../agent/run-shell"

/** Extract the command from a `!command` line, or null when it is not one. */
export function parseBang(text: string): string | null {
  if (!text.startsWith("!")) return null
  const command = text.slice(1).trim()
  return command.length > 0 ? command : null
}

/** Format a shell result into the cell body: stdout, then stderr, then a
 * non-zero exit-code note (or an interrupted note when Ctrl+C killed it). */
export function formatBashResult(result: ShellResult): string {
  const parts: string[] = []
  if (result.stdout.trim()) parts.push(result.stdout.replace(/\n+$/, ""))
  if (result.stderr.trim()) parts.push(result.stderr.replace(/\n+$/, ""))
  if (result.aborted) parts.push("[interrupted]")
  else if (result.code !== 0) parts.push(`[exit ${result.code}]`)
  return parts.join("\n") || "[no output]"
}

/**
 * Build the prompt sent to the agent when the user asks it to debug the last
 * failed `!command` (`/analyze`). Carries the command, exit code, and captured
 * output so the model has the full context without re-running anything. The
 * wording is the `developer.cli.bash-analysis` slot (ADR-0236).
 */
export function buildBashAnalysisPrompt(
  failure: {
    command: string
    output: string
    exitCode?: number
  },
  context: PromptResolutionContext = {}
): string {
  const exit = failure.exitCode !== undefined ? ` (exit code ${failure.exitCode})` : ""
  const output = failure.output.trim() || "[no output]"
  return resolvePrompt(CLI_BASH_ANALYSIS_PROMPT, {
    context,
    values: { exit, command: failure.command, output },
  }).text
}
