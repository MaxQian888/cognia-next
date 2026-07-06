import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PerfMetricTile } from "./perf-metric-tile"
import { wave } from "@/lib/storybook/fixtures/performance"

// A clickable left-rail tile (label + value + mini sparkline) that selects the
// active metric. `onSelect` is mocked with `fn()` so clicks are logged.
const meta = {
  title: "Performance/PerfMetricTile",
  component: PerfMetricTile,
  args: {
    label: "CPU",
    value: "42.3%",
    points: wave(40, 20, 50),
    color: "#22c55e",
    active: false,
    onSelect: fn(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-64">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PerfMetricTile>

export default meta
type Story = StoryObj<typeof meta>

export const Inactive: Story = {}

export const Active: Story = {
  args: { active: true },
}

export const Memory: Story = {
  args: { label: "Memory", value: "1.5 GB", color: "#6366f1", points: wave(40, 800, 900) },
}
