import type { Meta, StoryObj } from "@storybook/nextjs"

import { DetailsBlock } from "./details-block"

const meta = {
  title: "Chat/Renderers/DetailsBlock",
  component: DetailsBlock,
  parameters: { layout: "padded" },
  args: {
    summary: "Show implementation notes",
    children:
      "The renderer collapses long asides behind a disclosure triangle so the conversation stays scannable. Click the summary to expand.",
  },
} satisfies Meta<typeof DetailsBlock>

export default meta
type Story = StoryObj<typeof meta>

// Collapsed by default — just the summary row.
export const Collapsed: Story = {}

// Pre-expanded so the body is visible in the static frame.
export const Open: Story = {
  args: { defaultOpen: true },
}

export const Bordered: Story = {
  args: { variant: "bordered", defaultOpen: true },
}

export const Filled: Story = {
  args: { variant: "filled", defaultOpen: true },
}
