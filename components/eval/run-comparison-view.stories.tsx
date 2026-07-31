import type { Meta, StoryObj } from "@storybook/nextjs"

import { RunComparisonView } from "./run-comparison-view"
import { makeRuns } from "@/lib/storybook/fixtures/eval"

// Run selector + A-vs-B(-vs-N) grid. Per-case verdicts are loaded from Dexie
// (`evalRunCaseResults`); against the empty Storybook DB the grid shows its
// "no cases" branch while the run checkboxes + pass@1 badges render fully.
const meta = {
  title: "Eval/RunComparisonView",
  component: RunComparisonView,
  parameters: { layout: "padded" },
  args: { runs: makeRuns() },
} satisfies Meta<typeof RunComparisonView>

export default meta
type Story = StoryObj<typeof meta>

export const MultipleRuns: Story = {}

// Only one candidate run → the "pick two" prompt.
export const SingleRun: Story = {
  args: { runs: makeRuns().slice(0, 1) },
}
