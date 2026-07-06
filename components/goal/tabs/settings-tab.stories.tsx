import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalSettingsTab } from "./settings-tab"
import { makeGoal } from "@/lib/storybook/fixtures/goal"

// Per-goal config editor. The form is disabled for terminal goals, so the
// editable vs. read-only states are the two meaningful variants.
const meta = {
  title: "Goal/SettingsTab",
  component: GoalSettingsTab,
  args: { goal: makeGoal() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalSettingsTab>

export default meta
type Story = StoryObj<typeof meta>

export const Editable: Story = {}

export const TerminalReadOnly: Story = {
  args: { goal: makeGoal({ status: "completed", endedAt: makeGoal().updatedAt }) },
}
