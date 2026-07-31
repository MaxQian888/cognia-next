import { matchGlob } from "@/lib/claude/permissions/ruleset"

/**
 * Decide whether a tool call is pre-approved by a `dontAsk` allow-list.
 *
 * `dontAsk` never surfaces a permission prompt: a tool matching the allow-list
 * is silently approved and everything else is denied. Entries follow the Claude
 * Agent SDK `allowedTools` format:
 *
 * - A bare tool name (`"Read"`, or `"*"` for any) approves the tool regardless
 *   of its input.
 * - A `Tool(specifier)` entry additionally requires the call's derived target
 *   (shell command / file path / url / …) to match the `specifier` glob. When
 *   no target can be derived, the specifier cannot be satisfied so the call is
 *   NOT approved — `dontAsk` fails closed.
 *
 * Tool-name and specifier matching both reuse {@link matchGlob}, so `*`/`?`
 * wildcards behave exactly as they do in the built-in permission engine.
 */
export function isToolPreApproved(
  toolName: string | undefined,
  rawInput: Record<string, unknown> | undefined,
  allowedTools: string[] | undefined
): boolean {
  if (!allowedTools?.length || !toolName) return false
  for (const entry of allowedTools) {
    if (!entry) continue
    const openParen = entry.indexOf("(")
    const base = openParen >= 0 ? entry.slice(0, openParen).trim() : entry.trim()
    if (!base || !matchGlob(base, toolName)) continue
    // Tool-level allow (no specifier) — approve regardless of input.
    if (openParen < 0) return true
    const closeParen = entry.lastIndexOf(")")
    const specifier = entry.slice(openParen + 1, closeParen > openParen ? closeParen : entry.length)
    const target = deriveTarget(rawInput)
    if (target != null && matchGlob(specifier, target)) return true
  }
  return false
}

/**
 * Best-effort extraction of the glob target from a tool call's raw input. Reads
 * the conventional input keys used across the built-in tools (shell command,
 * file path, url, search pattern). Returns `undefined` when none is present so
 * a specifier-qualified rule fails closed.
 */
function deriveTarget(rawInput: Record<string, unknown> | undefined): string | undefined {
  if (!rawInput) return undefined
  for (const key of ["command", "file_path", "filePath", "path", "url", "pattern"]) {
    const value = rawInput[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}
