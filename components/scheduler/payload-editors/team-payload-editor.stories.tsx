import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TeamPayloadEditor } from "./team-payload-editor"
import type { AgentTeamDraft } from "./types"

// Structured editor for `agent-team` tasks (ADR-0022). `teamsForTesting`
// bypasses the team store — when non-empty the teamId field is a select; when
// empty it falls back to a free-text id input.
const TEAMS = [
  { id: "team-research", name: "Research Pod" },
  { id: "team-ship", name: "Shipping Crew" },
]

const meta = {
  title: "Scheduler/PayloadEditors/TeamPayloadEditor",
  component: TeamPayloadEditor,
  parameters: { layout: "padded" },
  args: {
    onDraftChange: fn(),
    testId: "team-payload-editor",
  },
} satisfies Meta<typeof TeamPayloadEditor>

export default meta
type Story = StoryObj<typeof meta>

const EMPTY: AgentTeamDraft = { teamId: "", ultracode: false }

// No teams configured → free-text teamId input, empty draft.
export const EmptyNoTeams: Story = {
  args: { draft: EMPTY, teamsForTesting: [] },
}

// Teams available → select with one chosen.
export const WithTeams: Story = {
  args: {
    draft: { teamId: "team-research", ultracode: false },
    teamsForTesting: TEAMS,
  },
}

// Ultracode toggle enabled.
export const UltracodeEnabled: Story = {
  args: {
    draft: { teamId: "team-ship", ultracode: true },
    teamsForTesting: TEAMS,
  },
}

// Submit attempted without a team → inline validation error.
export const WithError: Story = {
  args: {
    draft: EMPTY,
    teamsForTesting: [],
    errors: { teamId: "teamIdRequired" },
  },
}

// Disabled (read-only).
export const Disabled: Story = {
  args: {
    draft: { teamId: "team-research", ultracode: true },
    teamsForTesting: TEAMS,
    disabled: true,
  },
}
