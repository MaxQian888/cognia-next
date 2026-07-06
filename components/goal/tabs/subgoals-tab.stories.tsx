import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalSubgoalsTab } from "./subgoals-tab"
import { makeGoal } from "@/lib/storybook/fixtures/goal"

// Subgoal checklist. The component live-binds to the Dexie goal row but falls
// back to the `goal` prop when the row is absent (empty DB in Storybook), so
// passing `subgoals` inline drives the populated state without seeding.
const meta = {
  title: "Goal/SubgoalsTab",
  component: GoalSubgoalsTab,
  args: { goal: makeGoal() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalSubgoalsTab>

export default meta
type Story = StoryObj<typeof meta>

// No subgoals yet → the dashed empty-state prompt to generate.
export const Empty: Story = {}

export const WithSubgoals: Story = {
  args: {
    goal: makeGoal({
      subgoals: [
        { id: "sg1", text: "Reproduce the auth bug locally", done: true, order: 0 },
        { id: "sg2", text: "Draft a fix for the token refresh race", done: true, order: 1 },
        { id: "sg3", text: "Add a regression test", done: false, order: 2 },
        { id: "sg4", text: "Write migration notes for the v2 schema", done: false, order: 3 },
      ],
    }),
  },
}
