import type { Meta, StoryObj } from "@storybook/nextjs"

import { PlanTrackerPanel } from "./plan-tracker-panel"
import { buildPlan } from "@/lib/storybook/fixtures/agent-plan"

const meta = {
  title: "Agent/Plan/PlanTrackerPanel",
  component: PlanTrackerPanel,
  args: { plan: buildPlan() },
} satisfies Meta<typeof PlanTrackerPanel>

export default meta
type Story = StoryObj<typeof meta>

// Executing plan: live status badges + progress, current step bolded.
export const Executing: Story = {}

export const Completed: Story = {
  args: {
    plan: buildPlan({
      status: "completed",
      currentStepId: undefined,
      steps: buildPlan().steps.map((s) => ({ ...s, status: "completed" as const })),
    }),
  },
}

export const Empty: Story = {
  args: { plan: buildPlan({ steps: [], totalSteps: 0, completedSteps: 0 }) },
}
