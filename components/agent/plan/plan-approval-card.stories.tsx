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
    onReject: fn(),
  },
} satisfies Meta<typeof PlanApprovalCard>

export default meta
type Story = StoryObj<typeof meta>

// Approve / reject only (no refine controls).
export const Default: Story = {}

// With onRefine, the four refinement buttons appear.
export const WithRefine: Story = {
  args: { onRefine: fn() },
}

// A partially-executed plan shows progress + struck-through completed steps.
export const InProgress: Story = {
  args: { plan: buildPlan() },
}

export const NoSteps: Story = {
  args: { plan: buildDraftPlan({ steps: [], totalSteps: 0, completedSteps: 0 }) },
}
