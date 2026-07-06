import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RunDetailSheet } from "./run-detail-sheet"
import { FIXTURE_NOW } from "@/lib/storybook/fixtures/scheduler"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

// `RunDetailSheet` is a pure controlled `Sheet`. There is no fixture builder
// for `UnifiedExecutionRun`, so we construct realistic records inline. Stories
// render the sheet OPEN so the body (timing / payload / result / error / logs)
// is visible.
function makeRun(over: Partial<UnifiedExecutionRun> = {}): UnifiedExecutionRun {
  const startedAt = FIXTURE_NOW - 60_000
  const finishedAt = FIXTURE_NOW
  return {
    unifiedId: "workflow:run-1",
    kind: "workflow",
    itemUnifiedId: "workflow:wf-1",
    itemName: "Nightly ETL workflow",
    status: "succeeded",
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    payload: { trigger: "cron", cron: "0 2 * * *" },
    result: { rowsProcessed: 1280, warnings: 0 },
    logs: [
      { ts: startedAt, level: "info", message: "Run started" },
      { ts: startedAt + 20_000, level: "debug", message: "Fetched 1280 rows" },
      { ts: finishedAt, level: "info", message: "Run completed" },
    ],
    triggerSource: "schedule",
    origin: { tableName: "workflowRuns", nativeId: "run-1" },
    ...over,
  }
}

const meta = {
  title: "Scheduler/RunDetailSheet",
  component: RunDetailSheet,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof RunDetailSheet>

export default meta
type Story = StoryObj<typeof meta>

/** A successful workflow run with payload, result, and logs. */
export const Succeeded: Story = {
  args: { run: makeRun() },
}

/** A failed run — shows the red error block with code + stack. */
export const Failed: Story = {
  args: {
    run: makeRun({
      status: "failed",
      itemName: "Daily standup digest",
      kind: "app",
      result: undefined,
      error: {
        message: "Sidecar request timed out after 30s",
        code: "ETIMEDOUT",
        stack: "Error: Sidecar request timed out\n  at runTask (task-scheduler.ts:142)",
      },
      logs: [
        { ts: FIXTURE_NOW - 60_000, level: "info", message: "Run started" },
        { ts: FIXTURE_NOW - 10_000, level: "error", message: "Timed out waiting for sidecar" },
      ],
    }),
  },
}

/** An in-flight run — no finished time / duration yet. */
export const Running: Story = {
  args: {
    run: makeRun({
      status: "running",
      finishedAt: undefined,
      durationMs: undefined,
      result: undefined,
      logs: [{ ts: FIXTURE_NOW - 5_000, level: "info", message: "Run started" }],
    }),
  },
}

/** A skipped connector run with no payload, result, or logs. */
export const Skipped: Story = {
  args: {
    run: makeRun({
      status: "skipped",
      kind: "connector",
      itemName: "Slack daily summary",
      payload: undefined,
      result: undefined,
      logs: [],
      triggerSource: undefined,
      origin: { tableName: "connectorAudit", nativeId: "audit-9" },
    }),
  },
}
