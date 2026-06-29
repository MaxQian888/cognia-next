import type { Meta, StoryObj } from "@storybook/nextjs"

import { RunVerticalGantt } from "./run-vertical-gantt"
import { makeRun } from "@/lib/storybook/fixtures/mobile-workflow"

// Touch-friendly vertical run list — a timeline dot + status badge + duration
// per run. Pure: it takes the runs array directly.
const meta = {
  title: "Mobile/Workflow/RunVerticalGantt",
  component: RunVerticalGantt,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px] rounded-md border border-border bg-card">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RunVerticalGantt>

export default meta
type Story = StoryObj<typeof meta>

export const MixedStatuses: Story = {
  args: {
    runs: [
      makeRun({ id: "r1", status: "running", completedAt: undefined }),
      makeRun({ id: "r2", status: "succeeded" }),
      makeRun({ id: "r3", status: "failed", error: { message: "Step 2 timed out" } }),
      makeRun({ id: "r4", status: "cancelled" }),
    ],
  },
}

export const SingleSucceeded: Story = {
  args: { runs: [makeRun({ id: "r1", status: "succeeded" })] },
}

export const Empty: Story = {
  args: { runs: [] },
}
