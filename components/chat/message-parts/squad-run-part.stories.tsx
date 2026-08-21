import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { SquadRunPart } from "./squad-run-part"
import type { SquadRunPart as SquadRunPartType } from "@/lib/claude/parts-extensions"

const PART: SquadRunPartType = {
  type: "squad-run",
  runId: "execution:team:run_team_abc123",
  squadId: "sq-1",
  squadName: "Research Squad",
  objective: "Audit the auth flow and write up what a rotation would break.",
}

const meta = {
  title: "Chat/MessageParts/SquadRunPart",
  component: SquadRunPart,
  args: { part: PART },
  parameters: {
    docs: {
      description: {
        component:
          "The conversation's record of a turn handed to a Squad. Steps are folded away by default — a Squad is an executor, not a room full of speakers. Status and steps are live-queried from the execution run, so these stories show the no-run shape; the populated states are covered by the co-located tests, which seed Dexie.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SquadRunPart>

export default meta
type Story = StoryObj<typeof meta>

/** The run row is not on this device — says so instead of inventing a status. */
export const RunNotOnThisDevice: Story = {}

/** A long objective clamps to two lines rather than pushing the card open. */
export const LongObjective: Story = {
  args: {
    part: {
      ...PART,
      objective:
        "Go through every provider adapter, find the ones that still swallow a 429 without surfacing a retry-after, and propose a single shared backoff so the behaviour stops depending on which provider the user happened to pick.",
    },
  },
}

/** A Squad deleted after the fact still reads as something. */
export const DeletedSquad: Story = {
  args: { part: { ...PART, squadName: "sq-1" } },
}
