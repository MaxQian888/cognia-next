import type { Meta, StoryObj } from "@storybook/nextjs"

import { PerfSparkline } from "./perf-sparkline"
import { wave } from "@/lib/storybook/fixtures/performance"

// `PerfSparkline` is the shared tiny filled-area trend. It fills the box the
// caller sizes via `className`, so each story gives it an explicit box.
const meta = {
  title: "Performance/PerfSparkline",
  component: PerfSparkline,
  args: { points: wave(40, 20, 50), color: "#22c55e", className: "h-12 w-40" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PerfSparkline>

export default meta
type Story = StoryObj<typeof meta>

export const Rising: Story = {}

export const Flatline: Story = {
  args: { points: Array(40).fill(8), color: "#f59e0b" },
}

export const Indigo: Story = {
  args: { points: wave(40, 200, 600), color: "#6366f1", strokeWidth: 2, fillOpacity: 0.3 },
}

export const Tiny: Story = {
  args: { points: wave(24, 10, 30), color: "#ef4444", className: "h-6 w-16" },
}
