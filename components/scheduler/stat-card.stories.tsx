import type { Meta, StoryObj } from "@storybook/nextjs"
import { CheckCircle, XCircle, Timer } from "lucide-react"

import { StatCard } from "./stat-card"

// `StatCard` is a pure presentational primitive — the gradient-accent KPI card
// shared by the desktop dashboard, the per-task detail strip, and the mobile
// carousel. Stories cover both sizes and a few accent palettes.
const meta = {
  title: "Scheduler/StatCard",
  component: StatCard,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    label: "Successful",
    value: 40,
    icon: <CheckCircle className="h-4 w-4 text-green-500" />,
    valueClassName: "text-green-500",
    accentGradient: "from-green-500 to-emerald-400",
    iconBgClassName: "bg-green-500/10",
  },
}

export const FailureAccent: Story = {
  args: {
    label: "Failed",
    value: 2,
    icon: <XCircle className="h-4 w-4 text-red-500" />,
    valueClassName: "text-red-500",
    accentGradient: "from-red-500 to-rose-400",
    iconBgClassName: "bg-red-500/10",
  },
}

export const StringValue: Story = {
  args: {
    label: "Next Run",
    value: "in 2 hours",
    icon: <Timer className="h-4 w-4 text-purple-500" />,
    valueClassName: "text-purple-500",
    accentGradient: "from-purple-500 to-violet-400",
    iconBgClassName: "bg-purple-500/10",
  },
}

export const CompactSize: Story = {
  args: {
    ...Default.args,
    size: "sm",
  },
}
