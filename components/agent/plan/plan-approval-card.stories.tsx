import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PlanApprovalCard } from "./plan-approval-card"
import { buildDraftPlan, buildMarkdownPlan, buildPlan } from "@/lib/storybook/fixtures/agent-plan"

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

// An `exit_plan_mode` plan renders its full markdown body (headings, lists,
// code, blockquote) instead of the lossy step-title list.
export const MarkdownBody: Story = {
  args: { plan: buildMarkdownPlan() },
}

// With onEdit, the pencil toggle opens the raw-markdown editor for a plan that
// carries a markdown body (rather than the one-step-per-line editor).
export const MarkdownWithEdit: Story = {
  args: { plan: buildMarkdownPlan(), onEdit: fn() },
}

// A partially-executed plan shows progress + struck-through completed steps.
export const InProgress: Story = {
  args: { plan: buildPlan() },
}

export const NoSteps: Story = {
  args: { plan: buildDraftPlan({ steps: [], totalSteps: 0, completedSteps: 0 }) },
}
