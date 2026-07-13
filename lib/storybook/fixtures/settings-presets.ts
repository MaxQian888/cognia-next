// Storybook-only fixture builders for the Settings → Presets components
// (preset cards, list toolbar, editor + editor sections). Mirrors the cast-
// through-`unknown` pattern of the other settings fixtures: we build only the
// fields the components read.
import type { SystemPromptPreset } from "@cognia/agent-config-types"

/**
 * Build a `SystemPromptPreset` with sensible defaults. Pass overrides to vary
 * the card/editor appearance (default/favorite/built-in badges, category, …).
 */
export function makePreset(over: Partial<SystemPromptPreset> = {}): SystemPromptPreset {
  const now = Date.UTC(2026, 5, 1)
  return {
    id: "preset-1",
    name: "Senior code reviewer",
    content: "You are a meticulous senior engineer. Review diffs for correctness and clarity.",
    description: "Sharp, terse code-review persona.",
    icon: "🧐",
    color: "oklch(0.7 0.14 250)",
    category: "coding",
    model: "claude-opus-4",
    createdAt: now,
    updatedAt: now,
    ...over,
  } as SystemPromptPreset
}
