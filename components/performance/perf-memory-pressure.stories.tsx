import type { Meta, StoryObj } from "@storybook/nextjs"

import { PerfMemoryPressure } from "./perf-memory-pressure"
import { makeMemory } from "@/lib/storybook/fixtures/performance"

const GB = 1024 * 1024 * 1024

// macOS-Activity-Monitor-style memory pressure gauge. The pressure level
// (low / moderate / high) is derived from used / total, so each story moves the
// `usedBytes` across the thresholds.
const meta = {
  title: "Performance/PerfMemoryPressure",
  component: PerfMemoryPressure,
  args: { memory: makeMemory({ totalBytes: 16 * GB, usedBytes: 6 * GB }) },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PerfMemoryPressure>

export default meta
type Story = StoryObj<typeof meta>

export const Low: Story = {}

export const Moderate: Story = {
  args: { memory: makeMemory({ totalBytes: 16 * GB, usedBytes: 12 * GB }) },
}

export const High: Story = {
  args: { memory: makeMemory({ totalBytes: 16 * GB, usedBytes: 15 * GB }) },
}

// `null` memory renders the em-dash placeholder state.
export const NoData: Story = {
  args: { memory: null },
}
