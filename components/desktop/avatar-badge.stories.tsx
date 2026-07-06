import type { Meta, StoryObj } from "@storybook/nextjs"

import { AvatarBadge } from "./avatar-badge"

// Shared avatar primitive: a colored circle with the subject's emoji or initials
// (or an image, falling back to the glyph on load error). Used by the guild rail,
// channel list, command palette, and member list.
const meta = {
  title: "Desktop/AvatarBadge",
  component: AvatarBadge,
  parameters: { layout: "centered" },
  args: { subject: { name: "Ada Lovelace" }, size: 32 },
} satisfies Meta<typeof AvatarBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Initials: Story = {}

export const Emoji: Story = {
  args: { subject: { name: "Research Bot", avatarEmoji: "🤖" } },
}

export const CustomColor: Story = {
  args: { subject: { name: "Crimson", avatarColor: "#dc2626" } },
}

export const Large: Story = {
  args: { size: 64, textClassName: "text-xl" },
}

export const WithStatusDot: Story = {
  args: {
    size: 40,
    statusDot: (
      <span className="absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-background bg-emerald-500" />
    ),
  },
}
