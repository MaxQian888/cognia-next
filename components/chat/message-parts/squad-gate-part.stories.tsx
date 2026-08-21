import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { SquadGatePart } from "./squad-gate-part"
import type { SquadGatePart as SquadGatePartType } from "@/lib/claude/parts-extensions"

const PART: SquadGatePartType = {
  type: "squad-gate",
  runId: "execution:team:run_team_abc123",
  gateType: "budget",
  decision: "approved",
  title: "Token budget critical — raise the ceiling and continue?",
  answeredAt: 1,
}

const meta = {
  title: "Chat/MessageParts/SquadGatePart",
  component: SquadGatePart,
  args: { part: PART },
  parameters: {
    docs: {
      description: {
        component:
          "A receipt, not a call to action: by the time it renders the decision is made and the run has moved on. It exists because the gate dialog is app-root mounted and vanishes when answered, leaving nothing that could say what was approved, or when.",
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
} satisfies Meta<typeof SquadGatePart>

export default meta
type Story = StoryObj<typeof meta>

export const Approved: Story = {}

export const Rejected: Story = {
  args: {
    part: {
      ...PART,
      decision: "rejected",
      gateType: "plan",
      title: "Approve the lead's plan before it runs?",
    },
  },
}

/** The waiter died with the previous page — dismissed, never answered. */
export const Dismissed: Story = {
  args: {
    part: {
      ...PART,
      decision: "dismissed",
      gateType: "deadlock",
      title: "Every teammate is unavailable",
    },
  },
}

/** A long gate title truncates rather than wrapping the one-line receipt. */
export const LongTitle: Story = {
  args: {
    part: {
      ...PART,
      title:
        "The lead wants to widen the permission ceiling for the remaining three tasks because two of them need to write outside the workspace root",
    },
  },
}
