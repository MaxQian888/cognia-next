import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LoopDetailSheet } from "./loop-detail-sheet"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeLoop, makeLoopEventLog } from "@/lib/storybook/fixtures/loop"

const loop = makeLoop()

// Detail surface for a `/loop` (Overview / Activity / Settings) in the shared
// responsive Sheet/Drawer. The Activity tab reads `loopEvents`, so the Open
// story seeds a log.
const meta = {
  title: "Loop/LoopDetailSheet",
  component: LoopDetailSheet,
  args: { loop, open: true, onOpenChange: fn() },
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.loopEvents.bulkAdd(makeLoopEventLog(loop.id))
    })
  },
} satisfies Meta<typeof LoopDetailSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const IntervalMode: Story = {
  args: { loop: makeLoop({ mode: "interval", intervalMs: 300_000 }) },
}

export const Closed: Story = {
  args: { open: false },
}
