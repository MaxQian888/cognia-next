import type { Meta, StoryObj } from "@storybook/nextjs"

import { EffortSelector } from "./effort-selector"
import type { ChatSession } from "@/lib/claude/types"

// EffortSelector self-gates to `null` unless there is a session AND the active
// model supports reasoning effort (`modelSupportsEffort`). On the Anthropic path
// the effort families are Opus 4.5–4.9, Sonnet 4.6, and Fable/Mythos 5 — NOT
// Sonnet 4.5 / Haiku / Opus 4.0–4.1. We pin the session to an effort-capable
// model (`claude-opus-4-8`); using Sonnet 4.5 would render nothing.
function session(effort?: ChatSession["effort"]): ChatSession {
  return {
    id: "sess-effort-1",
    title: "Refactor the composer toolbar",
    model: "claude-opus-4-8",
    providerOverride: "anthropic",
    effort,
  } as ChatSession
}

const meta = {
  title: "Chat/Composer/EffortSelector",
  component: EffortSelector,
  parameters: { layout: "padded" },
} satisfies Meta<typeof EffortSelector>

export default meta
type Story = StoryObj<typeof meta>

// No per-session effort → trigger shows the "Auto" (use-model-default) label.
export const Auto: Story = {
  args: { session: session() },
}

// Explicit per-session override → trigger reflects the chosen level.
export const HighEffort: Story = {
  args: { session: session("high") },
}

// Streaming in flight → the trigger is disabled.
export const Disabled: Story = {
  args: { session: session("max"), disabled: true },
}
