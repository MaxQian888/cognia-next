import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PlanPayloadEditor } from "./plan-payload-editor"
import type { PlanDraft } from "./types"

// Structured editor for `plan` tasks (ADR-0045). `plansForTesting` bypasses the
// Dexie plan lookup — when non-empty the planId field is a select; when empty it
// falls back to a free-text id input.
const PLANS = [
  { id: "plan-migrate-db", title: "Migrate to Dexie v92", status: "ready" },
  { id: "plan-refactor-ui", title: "Refactor scheduler UI", status: "draft" },
]

const meta = {
  title: "Scheduler/PayloadEditors/PlanPayloadEditor",
  component: PlanPayloadEditor,
  parameters: { layout: "padded" },
  args: {
    onDraftChange: fn(),
    testId: "plan-payload-editor",
  },
} satisfies Meta<typeof PlanPayloadEditor>

export default meta
type Story = StoryObj<typeof meta>

const EMPTY: PlanDraft = { planId: "", replanOnFailure: false }

// No stored plans → free-text planId input, empty draft.
export const EmptyNoPlans: Story = {
  args: { draft: EMPTY, plansForTesting: [] },
}

// Stored plans available → select with one chosen.
export const WithPlans: Story = {
  args: {
    draft: { planId: "plan-migrate-db", replanOnFailure: false },
    plansForTesting: PLANS,
  },
}

// Replan-on-failure enabled.
export const ReplanEnabled: Story = {
  args: {
    draft: { planId: "plan-refactor-ui", replanOnFailure: true },
    plansForTesting: PLANS,
  },
}

// Submit attempted without a plan → inline validation error.
export const WithError: Story = {
  args: {
    draft: EMPTY,
    plansForTesting: [],
    errors: { planId: "planIdRequired" },
  },
}

// Disabled (read-only).
export const Disabled: Story = {
  args: {
    draft: { planId: "plan-migrate-db", replanOnFailure: true },
    plansForTesting: PLANS,
    disabled: true,
  },
}
