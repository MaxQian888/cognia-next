// The `allowedTools` whitelist on the AI SDK rail.

/**
 * Claude-Code canonical name → cognia AI-SDK bare name, for the core file
 * tools whose name diverges across the two dispatch paths. `allowedTools` (a
 * character/skill/mode tool whitelist) is authored in Claude-Code naming
 * (`Read`, `Grep`, `Bash`, …) because it targets the native Anthropic path; on
 * the AI-SDK path the equivalent built-in tools carry cognia bare names
 * (`read`, `grep`, `bash`, …). Without this bridge an allow list like
 * `["Read"]` would match nothing and filter every tool out — the opposite of
 * the intended "scope the palette to Read" semantics. Tools that share a name
 * across both paths (plugin tools, TodoWrite, git_*, …) need no entry.
 */
export const CLAUDE_TOOL_NAME_BY_COGNIA_BARE: Readonly<Record<string, string>> = Object.freeze({
  read: "Read",
  write: "Write",
  edit: "Edit",
  multi_edit: "MultiEdit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  ls: "LS",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
})

/**
 * Decide whether a tool with the given candidate allow-names passes the
 * `allowedTools` whitelist. An absent/empty whitelist means "no restriction"
 * (every enabled tool is exposed). A non-empty whitelist exposes a tool only
 * when at least one of its candidate names appears in the list.
 *
 * `candidateNames` holds the bare, namespaced, and (for core tools) the
 * Claude-Code alias — any match admits the tool.
 */
export function passesAllowList(
  allowSet: ReadonlySet<string> | null | undefined,
  candidateNames: readonly string[]
): boolean {
  if (!allowSet || allowSet.size === 0) return true
  return candidateNames.some((n) => allowSet.has(n))
}
