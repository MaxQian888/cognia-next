import type { Meta, StoryObj } from "@storybook/nextjs"

import { GateModalsHost } from "./gate-modals-host"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { usePendingGatesStore, type PendingGate } from "@/stores/agent/pending-gates-store"

const budgetGate: PendingGate = {
  key: { scope: "team-budget", id: "team-1" },
  status: "open",
  gateType: "budget",
  title: "Token budget reached",
  teamId: "team-1",
  runId: "run-1",
  openedAt: Date.UTC(2026, 5, 29, 10),
  body: "The team has consumed its token budget. Approve more to continue?",
}

const meta = {
  title: "Agent/Team/GateModalsHost",
  component: GateModalsHost,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(usePendingGatesStore)
  },
} satisfies Meta<typeof GateModalsHost>

export default meta
type Story = StoryObj<typeof meta>

// No pending gates → the host renders nothing.
export const NoGates: Story = {}

// One open budget gate → a dialog bound to the approval bus.
export const OneGate: Story = {
  decorators: [
    (Story) => {
      seedStore(usePendingGatesStore, { gates: [budgetGate] })
      return <Story />
    },
  ],
}
