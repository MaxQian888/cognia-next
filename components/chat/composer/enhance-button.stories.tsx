import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { EnhanceButton } from "./enhance-button"
import type { ChatSession } from "@/lib/claude/types"

// EnhanceButton is a Wand trigger opening a menu of rewrite modes (improve /
// concise / detailed / …). Picking one runs `enhancePrompt` through the
// utility LLM client — that network call only fires on click, so the default
// render (trigger + dropdown) needs no model wiring. The story exercises the
// chrome; running an actual rewrite requires a configured utility model.
const session: ChatSession = {
  id: "sess-enhance-1",
  title: "Draft the release notes",
  model: "claude-sonnet-4-5",
  providerOverride: "anthropic",
} as ChatSession

const meta = {
  title: "Chat/Composer/EnhanceButton",
  component: EnhanceButton,
  parameters: { layout: "padded" },
  args: {
    onApply: fn(),
    session,
    value: "make the onboarding email better and shorter",
  },
} satisfies Meta<typeof EnhanceButton>

export default meta
type Story = StoryObj<typeof meta>

// Idle Wand trigger — click to open the rewrite-mode menu.
export const Default: Story = {}

// Streaming in flight → the trigger is disabled.
export const Disabled: Story = {
  args: { disabled: true },
}
