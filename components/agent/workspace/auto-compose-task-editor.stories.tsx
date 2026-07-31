import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AutoComposeTaskEditor } from "./auto-compose-task-editor"
import type { ProposedTask, ProposedTeammate } from "@/lib/ai/agent/team/auto/types"

const roster: ProposedTeammate[] = [
  { name: "Lead", role: "lead", description: "Coordinates." },
  { name: "Coder", role: "teammate", description: "Implements." },
]

const tasks: ProposedTask[] = [
  {
    title: "Reproduce the bug",
    description: "Capture the failing seed.",
    dependencies: [],
    assignedTo: 1,
  },
  {
    title: "Patch the reducer",
    description: "Fix the off-by-one.",
    dependencies: [0],
    assignedTo: 1,
  },
  { title: "Review and ship", description: "Open a PR.", dependencies: [1], assignedTo: 0 },
]

const meta = {
  title: "Agent/Workspace/AutoCompose/TaskEditor",
  component: AutoComposeTaskEditor,
  args: {
    tasks,
    roster,
    onChange: fn(),
    onAdd: fn(),
    onRemove: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[32rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AutoComposeTaskEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const SingleTask: Story = {
  args: { tasks: [tasks[0]] },
}
