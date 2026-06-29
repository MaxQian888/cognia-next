import type { Meta, StoryObj } from "@storybook/nextjs"

import { ReportKpiCards } from "./report-kpi-cards"
import { buildReport } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/ActivityReport/ReportKpiCards",
  component: ReportKpiCards,
  args: { report: buildReport() },
} satisfies Meta<typeof ReportKpiCards>

export default meta
type Story = StoryObj<typeof meta>

// Duration / tokens / success-rate / escalation KPI cards.
export const Default: Story = {}

// No summary → zeroed cards.
export const NoSummary: Story = {
  args: { report: buildReport({ summary: undefined, checkpoints: [] }) },
}
