import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TimeRangePicker } from "./time-range-picker"

// `TimeRangePicker` is the Grafana-style range trigger + popover (relative
// presets + absolute from/to). Pure props-only. The trigger label reflects the
// active preset or the pinned custom bounds.
const meta = {
  title: "Observability/TimeRangePicker",
  component: TimeRangePicker,
  args: {
    preset: "1h",
    customSince: null,
    customUntil: null,
    onPreset: fn(),
    onCustom: fn(),
  },
} satisfies Meta<typeof TimeRangePicker>

export default meta
type Story = StoryObj<typeof meta>

export const RelativePreset: Story = {}

export const SevenDays: Story = {
  args: { preset: "7d" },
}

export const CustomRange: Story = {
  args: {
    preset: "custom",
    customSince: Date.parse("2026-06-29T08:00:00Z"),
    customUntil: Date.parse("2026-06-29T16:30:00Z"),
  },
}

export const CustomWithoutBounds: Story = {
  args: { preset: "custom" },
}
