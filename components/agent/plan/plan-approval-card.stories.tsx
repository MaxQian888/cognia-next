import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PlanApprovalCard } from "./plan-approval-card"
import { buildDraftPlan, buildPlan } from "@/lib/storybook/fixtures/agent-plan"

const meta = {
  title: "Agent/Plan/PlanApprovalCard",
  component: PlanApprovalCard,
  args: {
    plan: buildDraftPlan(),
    onApprove: fn(),
    onKeepPlanning: fn(),
    onDiscard: fn(),
  },
} satisfies Meta<typeof PlanApprovalCard>

export default meta
type Story = StoryObj<typeof meta>

// Approve / keep-planning / discard only (no refine or edit affordances).
export const Default: Story = {}

// With onRefine, the refinement actions appear in the overflow menu.
export const WithRefine: Story = {
  args: { onRefine: fn() },
}

// With onEdit and an awaiting-approval plan, the pencil toggle opens the
// inline title/steps editor.
export const WithInlineEdit: Story = {
  args: { onEdit: fn() },
}

// A partially-executed plan shows progress + struck-through completed steps.
export const InProgress: Story = {
  args: { plan: buildPlan() },
}

export const NoSteps: Story = {
  args: { plan: buildDraftPlan({ steps: [], totalSteps: 0, completedSteps: 0 }) },
}
