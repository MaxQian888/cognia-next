/**
 * Claude Code parity: a composer line beginning with `#` quick-captures a memory
 * instead of sending it to the model. `# remember to use pnpm` saves the fact and
 * never reaches the conversation. Pure classifier so the App's submit handler
 * stays a one-liner and the rule is unit-tested without Ink.
 *
 * The hash must be followed by whitespace and a non-empty fact — so a markdown
 * heading the user actually wants to send (`#title`, no space) is NOT hijacked,
 * matching Claude Code's `#`-prefix convention.
 */

/** The fact a `#`-prefixed line captures, or null when it isn't a memory line. */
export function parseHashMemory(text: string): string | null {
  const m = /^#[ \t]+([\s\S]+)$/.exec(text)
  if (!m) return null
  const fact = m[1].trim()
  return fact.length > 0 ? fact : null
}
