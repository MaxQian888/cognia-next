import type { Meta, StoryObj } from "@storybook/nextjs"

import { TeamCard } from "./team-card"
import { makeTeam } from "@/lib/storybook/fixtures/mobile-discover"

// Team row — links into the agent-teams workspace. Pure; shows the member
// count and an optional built-in badge.
const meta = {
  title: "Mobile/Discover/TeamCard",
  component: TeamCard,
  parameters: { layout: "padded" },
  args: { team: makeTeam() },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TeamCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const BuiltIn: Story = {
  args: { team: makeTeam({ name: "Research squad", isBuiltIn: true }) },
}

export const SingleMember: Story = {
  args: {
    team: makeTeam({
      name: "Solo planner",
      members: [{ characterId: "char-1", role: "Planner" }],
      description: undefined,
    }),
  },
}
