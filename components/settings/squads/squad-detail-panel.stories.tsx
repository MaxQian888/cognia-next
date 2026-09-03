import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SquadDetailPanel } from "./squad-detail-panel"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

// One Squad's identity and roster in the settings library: name, description,
// the real roster editor, plugin panels, template provenance, derive actions,
// the danger zone, and the collapsed advanced group. Rows are created through
// the store's own actions so every teammate and task is fully formed.

const SQUAD_ID = "squad-story"

function seedSquad(): void {
  resetStore(useAgentTeamStore)
  const store = useAgentTeamStore.getState()
  const team = store.createTeam({
    name: "Parallel review",
    description: "A lead plus three reviewers who each take one slice of a pull request.",
    task: "Review pull request #482 across security, performance and style.",
    leadName: "Review lead",
    leadDescription: "Splits the diff and merges the three reviews into one verdict.",
  })
  // Stable id so the story's URL and args stay the same across reloads.
  useAgentTeamStore.setState((state) => {
    const { [team.id]: created, ...rest } = state.teams
    const teammates = Object.fromEntries(
      Object.entries(state.teammates).map(([id, teammate]) => [
        id,
        teammate.teamId === team.id ? { ...teammate, teamId: SQUAD_ID } : teammate,
      ])
    )
    return { teams: { ...rest, [SQUAD_ID]: { ...created, id: SQUAD_ID } }, teammates }
  })
  const fresh = useAgentTeamStore.getState()
  fresh.addTeammate({
    teamId: SQUAD_ID,
    name: "Security reviewer",
    description: "Looks for injection, auth and secret-handling mistakes.",
    config: { specialization: "security" },
  })
  fresh.addTeammate({
    teamId: SQUAD_ID,
    name: "Performance reviewer",
    description: "Checks render counts, allocations and query shapes.",
    config: { specialization: "performance" },
  })
  fresh.addTeammate({
    teamId: SQUAD_ID,
    name: "Style reviewer",
    description: "Naming, structure and the house i18n rule.",
    config: { specialization: "style" },
  })
  fresh.createTask({
    teamId: SQUAD_ID,
    title: "Security pass",
    description: "Review the auth changes in the diff.",
  })
  fresh.createTask({
    teamId: SQUAD_ID,
    title: "Performance pass",
    description: "Review the list virtualisation changes.",
  })
}

const meta = {
  title: "Settings/Squads/SquadDetailPanel",
  component: SquadDetailPanel,
  parameters: { layout: "padded" },
  args: { squadId: SQUAD_ID, onDeleted: fn() },
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SquadDetailPanel>

export default meta
type Story = StoryObj<typeof meta>

/** A four-member squad with two tasks and no template lineage. */
export const Default: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
    seedSquad()
  },
}

/** The Squad was deleted in another window while this pane was open. */
export const Missing: Story = {
  args: { squadId: "squad-gone" },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
}
