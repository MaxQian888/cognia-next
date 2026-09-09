/**
 * Map an agent definition's declared `color` onto something Ink's `<Text
 * color>` renders. Names come from the shared palette
 * (`lib/claude/agents/agent-color.ts`). The ANSI-native ones map to their
 * keyword so the user's terminal theme decides the exact shade, and the
 * three the 16-colour set lacks get fixed hex values. A hex colour passes
 * through. Anything undeclared yields the caller's fallback (normally the
 * theme accent), which is what every agent rendered as before colours
 * existed.
 */

import { isNamedAgentColor, normalizeAgentColor } from "@/lib/claude/agents/agent-color"

const NAMED_TO_INK: Record<string, string> = {
  red: "red",
  orange: "#ffa657",
  yellow: "yellow",
  green: "green",
  cyan: "cyan",
  blue: "blue",
  purple: "magenta",
  pink: "#ff7eb6",
  gray: "gray",
}

/** Resolve an agent colour for Ink, or return `fallback` when none applies. */
export function agentInkColor(color: string | undefined, fallback: string): string {
  const normalized = normalizeAgentColor(color)
  if (!normalized) return fallback
  if (isNamedAgentColor(normalized)) return NAMED_TO_INK[normalized] ?? fallback
  return normalized
}
