import type { Meta, StoryObj } from "@storybook/nextjs"

import { StatusBarSync } from "./status-bar-sync"

// Compact device-sync segment. Storybook has no paired devices, so it renders
// the "Sync not set up" face; clicking it opens the sync popover.
const meta = {
  title: "Desktop/StatusBar/Sync",
  component: StatusBarSync,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="flex h-6 items-center border-t bg-muted/40 text-[11px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusBarSync>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
