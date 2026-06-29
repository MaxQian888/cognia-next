import type { Meta, StoryObj } from "@storybook/nextjs"
import { InboxIcon } from "lucide-react"
import { fn } from "storybook/test"

import { EmptyState } from "./empty-state"

// Props-only placeholder used across the mobile surfaces. Stories cover the
// icon + title + description + CTA matrix.
const meta = {
  title: "Mobile/EmptyState",
  component: EmptyState,
  parameters: { layout: "padded" },
  args: {
    title: "No conversations yet",
  },
} satisfies Meta<typeof EmptyState>

export default meta
type Story = StoryObj<typeof meta>

export const TitleOnly: Story = {}

export const WithDescription: Story = {
  args: {
    description: "Start a new chat and it will show up right here.",
  },
}

export const WithIconAndCta: Story = {
  args: {
    icon: InboxIcon,
    description: "Your inbox is empty. Connect a channel to start receiving messages.",
    cta: { label: "Connect a channel", onSelect: fn(), testId: "empty-state-cta" },
  },
}
