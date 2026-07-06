import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AutoComposeRosterEditor } from "./auto-compose-roster-editor"
import { EMPTY_CAPABILITY_CATALOG } from "@/lib/ai/agent/team/auto/capability-catalog"
import type { ProposedTeammate } from "@/lib/ai/agent/team/auto/types"

const roster: ProposedTeammate[] = [
  { name: "Lead", role: "lead", description: "Coordinates the team and reviews output." },
  {
    name: "Coder",
    role: "teammate",
    description: "Implements the fix.",
    specialization: "backend",
  },
  {
    name: "Tester",
    role: "teammate",
    description: "Writes regression tests.",
    specialization: "testing",
  },
]

const meta = {
  title: "Agent/Workspace/AutoCompose/RosterEditor",
  component: AutoComposeRosterEditor,
  args: {
    roster,
    catalog: EMPTY_CAPABILITY_CATALOG,
    onChange: fn(),
    onAdd: fn(),
    onRemove: fn(),
    onSetLead: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[32rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AutoComposeRosterEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const SingleLead: Story = {
  args: { roster: [roster[0]] },
}
