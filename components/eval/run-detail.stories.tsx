import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RunDetail } from "./run-detail"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeRun } from "@/lib/storybook/fixtures/eval"

// Single-run drill-down. `getRun(runId)` + `useEvalRunCaseResults` read Dexie,
// so the run is seeded in `beforeEach`. The header (pass rates, cost, latency,
// gate verdict) is the focus; with no seeded case results the table shows its
// empty branch.
const meta = {
  title: "Eval/RunDetail",
  component: RunDetail,
  parameters: { layout: "padded" },
  args: { runId: "run-1", onBack: fn() },
} satisfies Meta<typeof RunDetail>

export default meta
type Story = StoryObj<typeof meta>

export const Loaded: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.evalRuns.put(
        makeRun({ runId: "run-1", targetLabel: "claude-opus", passAt1: 0.92, k: 3, passHatK: 0.97 })
      )
    })
  },
}

// A failing gate surfaces the failure reasons under the header.
export const GateFailed: Story = {
  args: { gate: { minPassAt1: 0.95, maxTotalCostUsd: 0.1 } },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.evalRuns.put(
        makeRun({ runId: "run-1", targetLabel: "gpt-baseline", passAt1: 0.71, totalCostUsd: 0.34 })
      )
    })
  },
}

// No matching run row → loading placeholder.
export const Loading: Story = {
  args: { runId: "missing-run" },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
