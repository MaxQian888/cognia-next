import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { UnreadPill } from "./unread-pill"

const meta = {
  title: "Inbox/UnreadPill",
  component: UnreadPill,
} satisfies Meta<typeof UnreadPill>

export default meta
type Story = StoryObj<typeof meta>

export const Normal: Story = { args: { count: 5 } }

export const NinetyNinePlus: Story = { args: { count: 150 } }

// count <= 0 renders nothing — wrapped so the empty result is visible in the panel.
export const Zero: Story = {
  args: { count: 0 },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <UnreadPill {...args} />
    </div>
  ),
}
