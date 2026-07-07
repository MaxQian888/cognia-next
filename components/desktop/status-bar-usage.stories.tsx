import type { Meta, StoryObj } from "@storybook/nextjs"

import { StatusBarUsage } from "./status-bar-usage"

// Compact usage/limits segment. It aggregates the configured provider accounts'
// limits via a Tauri-only query — in Storybook (web) that stays empty, so the
// chip renders nothing. Shown here for API/reference only.
const meta = {
  title: "Desktop/StatusBar/Usage",
  component: StatusBarUsage,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="flex h-6 items-center border-t bg-muted/40 text-[11px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusBarUsage>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
