import type { Meta, StoryObj } from "@storybook/nextjs"

import { ThinkingTips } from "./thinking-tips"

// A single rotating "did you know" tip surfaced beneath the thinking indicator
// once the wait runs long enough. The parent owns the tip list + rotating index.
const TIPS = [
  "Use Shift+Tab to cycle the permission mode.",
  "Type @ to reference a file or folder for the next turn.",
  "Press Esc to interrupt a running turn.",
  "Attach a skill with the sparkles button for one message.",
]

const meta = {
  title: "Chat/ThinkingTips",
  component: ThinkingTips,
  parameters: { layout: "padded" },
  args: {
    tips: TIPS,
    index: 0,
  },
} satisfies Meta<typeof ThinkingTips>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

/** A later index points at a different tip (wraps with modulo). */
export const SecondTip: Story = {
  args: { index: 1 },
}

/** Index beyond the list length wraps around. */
export const WrappedIndex: Story = {
  args: { index: 5 },
}

/** Empty tip list renders nothing. */
export const NoTips: Story = {
  args: { tips: [] },
}
