import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ApprovalGateDialog } from "./approval-gate-dialog"

const meta = {
  title: "Agent/Team/ApprovalGateDialog",
  component: ApprovalGateDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    gateType: "budget",
    scopeId: "team-1",
    onClose: fn(),
    onApprove: fn(),
    onReject: fn(),
  },
} satisfies Meta<typeof ApprovalGateDialog>

export default meta
type Story = StoryObj<typeof meta>

// Budget gate: extra-tokens input.
export const Budget: Story = {}

// Plan gate: approve applies the lead's re-plan as-is.
export const Plan: Story = {
  args: { gateType: "plan" },
}

// Deadlock gate: reset-all toggle + per-teammate reset checkboxes.
export const Deadlock: Story = {
  args: {
    gateType: "deadlock",
    quarantinedTeammates: [
      { id: "tm-1", name: "Researcher" },
      { id: "tm-2", name: "Coder" },
    ],
  },
}

export const TeammateFix: Story = {
  args: { gateType: "teammate_fix" },
}

// open=false → renders nothing.
export const Closed: Story = {
  args: { open: false },
}
