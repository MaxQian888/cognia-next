import type { Meta, StoryObj } from "@storybook/nextjs"
import { ActivityIcon, AlertTriangleIcon, DollarSignIcon, ZapIcon } from "lucide-react"

import { StatCard } from "./stat-card"

// `StatCard` is a pure props-only KPI tile (icon chip + label + value + optional
// trend arrow + sub-line). Stories cover each trend state, the optional sub-line
// and a custom color chip.
const meta = {
  title: "Observability/StatCard",
  component: StatCard,
  args: {
    icon: ActivityIcon,
    label: "Total spans",
    value: "1,284",
  },
  decorators: [
    (Story) => (
      <div className="w-[260px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithSubLine: Story = {
  args: {
    icon: DollarSignIcon,
    label: "Total cost",
    value: "$12.40",
    sub: "across 8 traces",
    color: "bg-chart-1/10 text-chart-1",
  },
}

export const TrendUp: Story = {
  args: {
    icon: AlertTriangleIcon,
    label: "Error rate",
    value: "4.2%",
    sub: "vs 1.1% last window",
    color: "bg-destructive/10 text-destructive",
    trend: "up",
  },
}

export const TrendDown: Story = {
  args: {
    icon: ZapIcon,
    label: "p95 latency",
    value: "820ms",
    sub: "improving",
    color: "bg-success/10 text-success",
    trend: "down",
  },
}

export const TrendStable: Story = {
  args: {
    label: "Requests / min",
    value: "26.7",
    trend: "stable",
  },
}

export const LongValue: Story = {
  args: {
    label: "Cumulative input + output tokens this window",
    value: "18,420,931",
    sub: "input + output + cache",
  },
}
