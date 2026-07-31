import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PerfToolbar } from "./perf-toolbar"

// Pause/resume, sampling-interval select, reset and export controls. All
// callbacks are mocked with `fn()` so the actions show up in the Actions panel.
const meta = {
  title: "Performance/PerfToolbar",
  component: PerfToolbar,
  args: {
    paused: false,
    intervalMs: 1000,
    onTogglePause: fn(),
    onIntervalChange: fn(),
    onReset: fn(),
    onExport: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PerfToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {}

export const Paused: Story = {
  args: { paused: true },
}
