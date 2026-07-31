import type { Meta, StoryObj } from "@storybook/nextjs"

import { LoopSettingsTab } from "./settings-tab"
import { makeLoop, LOOP_NOW } from "@/lib/storybook/fixtures/loop"

// Per-loop config editor (caps + self-paced delay bounds). Disabled for
// terminal loops. Self-paced shows the delay-bound fields; interval hides them.
const meta = {
  title: "Loop/SettingsTab",
  component: LoopSettingsTab,
  args: { loop: makeLoop() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LoopSettingsTab>

export default meta
type Story = StoryObj<typeof meta>

export const SelfPaced: Story = {}

export const IntervalMode: Story = {
  args: { loop: makeLoop({ mode: "interval", intervalMs: 300_000 }) },
}

export const TerminalReadOnly: Story = {
  args: { loop: makeLoop({ status: "completed", endedAt: LOOP_NOW }) },
}
