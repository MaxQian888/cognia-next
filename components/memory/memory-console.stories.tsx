import type { Meta, StoryObj } from "@storybook/nextjs"

import { MemoryConsole, type MemoryConsoleProps } from "./memory-console"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeMemorySet } from "@/lib/storybook/fixtures/memory"

// The full-page `/memory` management panel: stats, search/type/sort filters, and
// a live Dexie list with per-row edit/pin/delete. The populated story seeds the
// `memories` table; the empty story shows the empty state.
const meta = {
  title: "Memory/MemoryConsole",
  component: MemoryConsole,
  args: { initialSelectedId: undefined },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[680px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MemoryConsole>

export default meta
type Story = StoryObj<MemoryConsoleProps>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.memories.bulkAdd(makeMemorySet())
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
