import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentTeamTemplatesSection } from "./agent-team-templates-section"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

// `AgentTeamTemplatesSection` subscribes to `useAgentTeamStore`, whose initial
// state seeds the eight built-in agent-team templates. Resetting to the initial
// state in `beforeEach` keeps the built-ins visible and drops any forks created
// by a previous story.
const meta = {
  title: "Settings/Agent/AgentTeamTemplatesSection",
  component: AgentTeamTemplatesSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentTeamTemplatesSection>

export default meta
type Story = StoryObj<typeof meta>

// The built-in templates seeded by the store's initial state.
export const Default: Story = {}
