/**
 * The colour an agent definition may claim for its rows and badges.
 *
 * Claude Code and OpenCode both let an agent file declare `color:` so that
 * parallel runs are telling apart at a glance. Cognia accepts the same named
 * palette plus a hex value, normalised once here so every shell reads one
 * vocabulary. The CLI maps a name onto an Ink colour (`cli/src/tui/theme/
 * agent-color.ts`), the app maps it onto a token in the subagent card.
 *
 * Pure. No React, no shell imports, so it runs in the fast test project.
 */

/** Named colours in palette order (the order pickers should offer them). */
export const AGENT_COLOR_NAMES = [
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
  "gray",
] as const

export type AgentColorName = (typeof AGENT_COLOR_NAMES)[number]

/** A named palette entry or a `#rrggbb` hex value (always lower-case). */
export type AgentColor = AgentColorName | `#${string}`

/** Spellings other tools use for the same palette entry. */
const ALIASES: Record<string, AgentColorName> = {
  magenta: "purple",
  violet: "purple",
  grey: "gray",
  teal: "cyan",
  amber: "orange",
}

const HEX6 = /^#([0-9a-f]{6})$/i
const HEX3 = /^#([0-9a-f]{3})$/i

/**
 * Normalise a raw `color` value into an {@link AgentColor}. Names are
 * case-insensitive and aliases collapse onto the palette. `#rgb` expands to
 * `#rrggbb`. Anything else (empty, unknown name, malformed hex, non-string)
 * yields `undefined`, which callers treat as "no colour declared".
 */
export function normalizeAgentColor(raw: unknown): AgentColor | undefined {
  if (typeof raw !== "string") return undefined
  const value = raw.trim().toLowerCase()
  if (!value) return undefined
  if ((AGENT_COLOR_NAMES as readonly string[]).includes(value)) return value as AgentColorName
  const alias = ALIASES[value]
  if (alias) return alias
  const six = HEX6.exec(value)
  if (six) return `#${six[1]}`
  const three = HEX3.exec(value)
  if (three) {
    const [r, g, b] = three[1]
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return undefined
}

/** Whether a normalised colour is one of the named palette entries. */
export function isNamedAgentColor(color: AgentColor): color is AgentColorName {
  return (AGENT_COLOR_NAMES as readonly string[]).includes(color)
}
