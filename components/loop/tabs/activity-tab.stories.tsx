import type { Meta, StoryObj } from "@storybook/nextjs"

import { LoopActivityTab } from "./activity-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeLoop, makeLoopEventLog } from "@/lib/storybook/fixtures/loop"

const loop = makeLoop()

// Reverse-chrono lifecycle log from `loopEvents`. The populated story seeds a
// realistic log; the empty story leaves the DB empty.
const meta = {
  title: "Loop/ActivityTab",
  component: LoopActivityTab,
  args: { loop },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LoopActivityTab>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.loopEvents.bulkAdd(makeLoopEventLog(loop.id))
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
