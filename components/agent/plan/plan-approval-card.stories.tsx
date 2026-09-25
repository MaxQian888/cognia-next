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
    onReject: fn(),
    onOpenEditor: fn(),
    onOpenPanel: fn(),
  },
} satisfies Meta<typeof PlanApprovalCard>

export default meta
type Story = StoryObj<typeof meta>

// Approve / keep-planning / reject, the plan editor in the overflow menu.
export const Default: Story = {}

// With onRefine, the refinement presets appear in the overflow menu.
export const WithRefine: Story = {
  args: { onRefine: fn() },
}

// With onEdit, the document's step rows edit inline and autosave.
export const WithInlineEdit: Story = {
  args: { onEdit: fn() },
}

// An `exit_plan_mode` plan renders its full markdown body (headings, lists,
// code, blockquote) with the executable step list embedded in place.
export const MarkdownBody: Story = {
  args: { plan: buildMarkdownPlan() },
}

// With onEdit, a markdown plan also offers its raw source (header toggle).
export const MarkdownWithEdit: Story = {
  args: { plan: buildMarkdownPlan(), onEdit: fn() },
}

// A refinement in flight: the header says so, the body dims, actions wait.
export const Refining: Story = {
  args: { plan: buildMarkdownPlan(), onRefine: fn(), refining: true, disabled: true },
}

// A plan that has started shows each step's status instead of its number.
export const InProgress: Story = {
  args: { plan: buildPlan() },
}

export const NoSteps: Story = {
  args: { plan: buildDraftPlan({ steps: [], totalSteps: 0, completedSteps: 0 }) },
}
