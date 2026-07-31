import type { Meta, StoryObj } from "@storybook/nextjs"

import { LoopOverviewTab } from "./overview-tab"
import { makeLoop, LOOP_NOW } from "@/lib/storybook/fixtures/loop"

// Status badges, iteration/token budget bars, mode facts. Pure props (`loop`).
const meta = {
  title: "Loop/OverviewTab",
  component: LoopOverviewTab,
  args: { loop: makeLoop() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LoopOverviewTab>

export default meta
type Story = StoryObj<typeof meta>

export const SelfPaced: Story = {
  args: { loop: makeLoop({ nextDelayReason: "build still running" }) },
}

export const IntervalMode: Story = {
  args: { loop: makeLoop({ mode: "interval", intervalMs: 300_000 }) },
}

export const Completed: Story = {
  args: { loop: makeLoop({ status: "completed", endedAt: LOOP_NOW }) },
}
