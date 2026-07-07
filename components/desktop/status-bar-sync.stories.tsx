import type { Meta, StoryObj } from "@storybook/nextjs"

import { StatusBarSync } from "./status-bar-sync"

// Compact companion-sync segment. In Storybook the sync module returns its
// default (never-synced) in-memory state, so it renders the "not synced" face.
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
