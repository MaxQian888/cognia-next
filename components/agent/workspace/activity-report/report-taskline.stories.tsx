import type { Meta, StoryObj } from "@storybook/nextjs"

import { ReportTaskline } from "./report-taskline"
import { buildReport, buildTeammate } from "@/lib/storybook/fixtures/agent-team"

const teammates = [
  buildTeammate({ id: "tm-coder", name: "Coder", role: "teammate", status: "completed" }),
]

const meta = {
  title: "Agent/Workspace/ActivityReport/ReportTaskline",
  component: ReportTaskline,
  args: { report: buildReport(), teammates },
} satisfies Meta<typeof ReportTaskline>

export default meta
type Story = StoryObj<typeof meta>

// Swim-lane timeline of matched delegation segments.
export const Default: Story = {}

// No delegation checkpoints → empty state.
export const Empty: Story = {
  args: { report: buildReport({ checkpoints: [] }) },
}
