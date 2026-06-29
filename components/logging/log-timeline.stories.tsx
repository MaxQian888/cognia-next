import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LogTimeline } from "./log-timeline"
import { makeLogStream } from "@/lib/storybook/fixtures/logging"

// Pure: density bar bucketed from `logs` by timestamp + level. The component
// stays mounted on zero matches (renders a quiet placeholder bar).
const meta = {
  title: "Logging/LogTimeline",
  component: LogTimeline,
  parameters: { layout: "padded" },
  args: {
    logs: makeLogStream(120),
    onTimeRangeClick: fn(),
    onClearRange: fn(),
  },
} satisfies Meta<typeof LogTimeline>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

export const Empty: Story = { args: { logs: [] } }

// A selected range highlights the covered buckets and shows a clear chip.
export const WithSelectedRange: Story = {
  args: {
    selectedRange: {
      start: new Date(Date.now() - 30 * 60_000),
      end: new Date(Date.now() - 10 * 60_000),
    },
  },
}
