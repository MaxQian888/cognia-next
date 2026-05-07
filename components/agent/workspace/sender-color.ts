/**
 * Deterministic per-name color used by the agent-team workspace UI for
 * sender avatars (in the chat list, mention picker, and chip row).
 * Extracted into its own module so the picker, chips, and chat tab can all
 * import the same function without re-declaring it.
 */

const HUES = [
  "oklch(0.7 0.16 15)", // red
  "oklch(0.7 0.13 150)", // green
  "oklch(0.7 0.16 245)", // blue
  "oklch(0.7 0.16 90)", // yellow
  "oklch(0.7 0.13 320)", // purple
  "oklch(0.7 0.13 0)", // orange
  "oklch(0.7 0.13 200)", // teal
  "oklch(0.7 0.13 270)", // violet
] as const

export function senderColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return HUES[Math.abs(hash) % HUES.length]
}
