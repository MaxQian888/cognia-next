import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { RunsListView } from "./runs-list"
import type { EvalRunRow } from "@/lib/db/eval-runs"

const run = (over: Partial<EvalRunRow>): EvalRunRow =>
  ({
    runId: "r1",
    datasetId: "d1",
    datasetVersion: 1,
    targetLabel: "claude-opus",
    k: 1,
    caseCount: 20,
    scorers: {},
    passAt1: 0.92,
    passHatK: 0.92,
    totalCostUsd: 0.48,
    avgLatencyMs: 1200,
    createdAt: 1_717_400_000_000,
    ...over,
  }) as EvalRunRow

const runs: EvalRunRow[] = [
  run({ runId: "r1", targetLabel: "claude-opus", passAt1: 0.95, totalCostUsd: 0.62 }),
  run({
    runId: "r2",
    targetLabel: "claude-sonnet",
    k: 3,
    passAt1: 0.88,
    passHatK: 0.97,
    totalCostUsd: 0.21,
  }),
  run({ runId: "r3", targetLabel: "gpt-baseline", passAt1: 0.71, totalCostUsd: 0.34 }),
]

const meta = {
  title: "Eval/RunsListView",
  component: RunsListView,
  args: { runs, onOpenRun: fn() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof RunsListView>

export default meta
type Story = StoryObj<typeof meta>

export const WithRuns: Story = {}

// pass^k badge appears for k > 1; the gate badge appears with thresholds.
export const WithGate: Story = {
  args: { gate: { minPassAt1: 0.9 } },
}

export const Empty: Story = { args: { runs: [] } }
