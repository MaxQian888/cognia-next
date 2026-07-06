import type { Meta, StoryObj } from "@storybook/nextjs"

import { ReportTokenBurn } from "./report-token-burn"
import { buildReport } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/ActivityReport/ReportTokenBurn",
  component: ReportTokenBurn,
  args: { report: buildReport() },
} satisfies Meta<typeof ReportTokenBurn>

export default meta
type Story = StoryObj<typeof meta>

// Cumulative token-burn area chart from checkpoint token deltas.
export const Default: Story = {}

// No token deltas → empty state.
export const Empty: Story = {
  args: { report: buildReport({ checkpoints: [] }) },
}
