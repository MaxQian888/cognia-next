import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TraceWaterfallDrawer } from "./trace-waterfall-drawer"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeWindowSpans } from "@/lib/storybook/fixtures/observability"

// `TraceWaterfallDrawer` lazily loads one trace's spans from Dexie
// (`useTraceDetail` → `queryByTrace`) and renders the waterfall. The drawer is
// open when `traceId` is non-null. Stories seed the `agentTraces` table so the
// waterfall populates; the empty story points at a trace with no rows; the
// closed story passes `null`.
const meta = {
  title: "Observability/TraceWaterfallDrawer",
  component: TraceWaterfallDrawer,
  args: {
    traceId: "trace-01",
    onClose: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TraceWaterfallDrawer>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.agentTraces.bulkPut(makeWindowSpans())
    })
  },
}

export const EmptyTrace: Story = {
  args: { traceId: "trace-does-not-exist" },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.agentTraces.bulkPut(makeWindowSpans())
    })
  },
}

export const Closed: Story = {
  args: { traceId: null },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
