import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import type { ChatSession } from "@cognia/agent-config-types"

import { GoalGridTile } from "./goal-grid-tile"
import { GOAL_NOW, makeGoal } from "@/lib/storybook/fixtures/goal"

// One open goal as a tile for the Goals console's optional grid view: status
// chip, objective (selects into the inspector), conversation + agent, twin
// budget meters, an optional judge note, subgoal progress and the run
// controls (or Accept / Request changes while awaiting acceptance).
const meta = {
  title: "Goal/Console/GoalGridTile",
  component: GoalGridTile,
  args: {
    goal: makeGoal(),
    session: { id: "ses_a", title: "Fix flaky checkout e2e test" } as ChatSession,
    agentName: "Coding Assistant",
    judgeNote: null,
    selected: false,
    onSelect: fn(),
    onDeleted: fn(),
    now: GOAL_NOW,
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <ul className="w-80">
        <Story />
      </ul>
    ),
  ],
} satisfies Meta<typeof GoalGridTile>

export default meta
type Story = StoryObj<typeof meta>

export const Active: Story = {}

export const Selected: Story = {
  args: { selected: true },
}

export const Paused: Story = {
  args: { goal: makeGoal({ status: "paused" }) },
}

export const ManualContinue: Story = {
  args: { goal: makeGoal({ config: { ...makeGoal().config, manualContinue: true } }) },
}

export const AwaitingAcceptance: Story = {
  args: { goal: makeGoal({ status: "paused", awaitingAcceptance: true }) },
}

export const WithJudgeNoteAndSubgoals: Story = {
  args: {
    judgeNote: "Two of three fixes drafted; the auth bug still needs a repro.",
    goal: makeGoal({
      subgoals: [
        { id: "s1", text: "Reproduce", done: true, order: 0 },
        { id: "s2", text: "Draft fix", done: true, order: 1 },
        { id: "s3", text: "Verify", done: false, order: 2 },
      ],
    }),
  },
}

export const ConversationMissing: Story = {
  args: { session: null },
}
