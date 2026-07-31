import type { Meta, StoryObj } from "@storybook/nextjs"

import { ReportPluginSlot, PluginReportSlotPlaceholder } from "./report-plugin-slot"
import { buildReport, buildTeam } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/ActivityReport/ReportPluginSlot",
  component: ReportPluginSlot,
  args: { report: buildReport(), team: buildTeam() },
} satisfies Meta<typeof ReportPluginSlot>

export default meta
type Story = StoryObj<typeof meta>

// No plugin contributes to the slot → muted placeholder fallback.
export const Default: Story = {}

// The standalone fallback card on its own.
export const Placeholder: Story = {
  render: () => <PluginReportSlotPlaceholder />,
}
