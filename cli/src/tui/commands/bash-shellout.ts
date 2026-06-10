/**
 * Pure helpers for the `!command` shell-out (Claude-Code style). A leading `!`
 * on the submitted line runs the rest as a local shell command and shows the
 * output as a cell — no model round-trip. The actual spawn lives in
 * `agent/run-shell.ts` (injectable); this module is the pure parse + format.
 */
import type { ShellResult } from "../../agent/run-shell"

/** Extract the command from a `!command` line, or null when it is not one. */
export function parseBang(text: string): string | null {
  if (!text.startsWith("!")) return null
  const command = text.slice(1).trim()
  return command.length > 0 ? command : null
}

/** Format a shell result into the cell body: stdout, then stderr, then a
 * non-zero exit-code note. */
export function formatBashResult(result: ShellResult): string {
  const parts: string[] = []
  if (result.stdout.trim()) parts.push(result.stdout.replace(/\n+$/, ""))
  if (result.stderr.trim()) parts.push(result.stderr.replace(/\n+$/, ""))
  if (result.code !== 0) parts.push(`[exit ${result.code}]`)
  return parts.join("\n") || "[no output]"
}
