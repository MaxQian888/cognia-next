import type { Meta, StoryObj } from "@storybook/nextjs"

import { ExternalAgentPlan } from "./plan"
import type { AcpPlanEntry } from "@/types/agent/external-agent"

const ENTRIES: AcpPlanEntry[] = [
  { content: "Read the failing test and reproduce locally", priority: "high", status: "completed" },
  { content: "Locate the root cause in the reducer", priority: "high", status: "completed" },
  {
    content: "Patch the off-by-one and re-run the suite",
    priority: "medium",
    status: "in_progress",
  },
  { content: "Update the changelog", priority: "low", status: "pending" },
  { content: "Backport to the release branch", priority: "low", status: "skipped" },
]

const meta = {
  title: "Agent/ExternalAgent/Plan",
  component: ExternalAgentPlan,
  args: { entries: ENTRIES, currentStep: 2 },
} satisfies Meta<typeof ExternalAgentPlan>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Compact: Story = {
  args: { compact: true },
}

export const AllPending: Story = {
  args: {
    currentStep: 0,
    entries: ENTRIES.map((e) => ({ ...e, status: "pending" as const })),
  },
}

export const Completed: Story = {
  args: {
    currentStep: undefined,
    entries: ENTRIES.map((e) => ({ ...e, status: "completed" as const })),
  },
}

// No entries → the component renders nothing.
export const Empty: Story = {
  args: { entries: [] },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <ExternalAgentPlan {...args} />
    </div>
  ),
}
