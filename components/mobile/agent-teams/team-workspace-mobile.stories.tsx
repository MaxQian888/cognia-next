import type { Meta, StoryObj } from "@storybook/nextjs"

import { TeamWorkspaceMobile } from "./team-workspace-mobile"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

// Mobile agent-team workspace. Reads the team keyed by the `teamId` search
// param from `useAgentTeamStore`. In the Storybook browser there is no `teamId`
// query and no seeded team, so it renders the deterministic "team missing"
// empty state with a back-to-teams CTA. (The populated 3-tab workspace is
// driven by desktop workspace sections + a live store/route and is left to the
// desktop stories.)
const meta = {
  title: "Mobile/AgentTeams/TeamWorkspaceMobile",
  component: TeamWorkspaceMobile,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TeamWorkspaceMobile>

export default meta
type Story = StoryObj<typeof meta>

/** No `teamId` in the route — the missing-team empty state. */
export const TeamMissing: Story = {}
