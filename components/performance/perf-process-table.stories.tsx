import type { Meta, StoryObj } from "@storybook/nextjs"

import { PerfProcessTable } from "./perf-process-table"
import { makeHistory } from "@/lib/storybook/fixtures/performance"

// Sortable process tree (main app + sidecar + children) with a KPI summary row,
// CPU trend sparklines and a memory-share bar. Takes the full sample `history`
// and renders the most-recent frame.
const meta = {
  title: "Performance/PerfProcessTable",
  component: PerfProcessTable,
  args: { history: makeHistory(40) },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PerfProcessTable>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

// No frames yet → the empty-state copy.
export const Empty: Story = {
  args: { history: [] },
}
