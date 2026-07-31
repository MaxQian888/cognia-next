import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PlatformBadge } from "./platform-badge"
import { ALL_PLATFORM_KINDS, type PlatformKind } from "@/types/connectors/platform-kind"

const meta = {
  title: "Inbox/PlatformBadge",
  component: PlatformBadge,
  args: { platform: "telegram" },
} satisfies Meta<typeof PlatformBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const IconOnly: Story = { args: { iconOnly: true } }

export const AllPlatforms: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      {ALL_PLATFORM_KINDS.map((kind) => (
        <PlatformBadge key={kind} platform={kind} />
      ))}
    </div>
  ),
}

// An unrecognized kind falls back to the first two letters + muted color.
export const UnknownFallback: Story = {
  args: { platform: "myspace" as PlatformKind },
}
