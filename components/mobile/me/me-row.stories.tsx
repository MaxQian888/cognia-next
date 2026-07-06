import type { Meta, StoryObj } from "@storybook/nextjs"
import { BellIcon, LogOutIcon, ShieldCheckIcon } from "lucide-react"
import { fn } from "storybook/test"

import { MeRow } from "./me-row"

// Canonical /me list row. One component, three shapes: navigational (href),
// action (onClick), and value-only (neither). Stories exercise each plus the
// destructive / disabled / value / description variants.
const meta = {
  title: "Mobile/Me/MeRow",
  component: MeRow,
  parameters: { layout: "padded" },
  args: {
    label: "Notifications",
    onClick: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[360px] overflow-hidden rounded-xl border bg-card">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MeRow>

export default meta
type Story = StoryObj<typeof meta>

export const Action: Story = {
  args: { icon: BellIcon, description: "Push, sound, and quiet hours" },
}

export const Navigational: Story = {
  args: { icon: ShieldCheckIcon, label: "Security", href: "/me/security", onClick: undefined },
}

export const ValueOnly: Story = {
  args: { label: "Version", value: "1.4.2 (320)", onClick: undefined },
}

export const Destructive: Story = {
  args: { icon: LogOutIcon, label: "Sign out", destructive: true },
}

export const Disabled: Story = {
  args: { icon: BellIcon, label: "Notifications", description: "Pairing required", disabled: true },
}
