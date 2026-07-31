import type { Meta, StoryObj } from "@storybook/nextjs"

import { AtStrategyChip } from "./at-strategy-chip"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeAdapterInstance } from "@/lib/storybook/fixtures/inbox"

const ADAPTER_ID = "story-adapter"

// `AtStrategyChip` live-queries the bound `adapterInstances` row and renders
// nothing for the implicit "always" strategy. Seed an adapter per story so the
// restrictive strategies surface; the AlwaysHidden story seeds "always".
const meta = {
  title: "Inbox/AtStrategyChip",
  component: AtStrategyChip,
  args: { adapterId: ADAPTER_ID },
  parameters: { layout: "padded" },
} satisfies Meta<typeof AtStrategyChip>

export default meta
type Story = StoryObj<typeof meta>

export const MentionOnly: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.adapterInstances.put(
        makeAdapterInstance({ id: ADAPTER_ID, atResponseStrategy: "mention_only" })
      )
    })
  },
}

export const DirectOnly: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.adapterInstances.put(
        makeAdapterInstance({ id: ADAPTER_ID, atResponseStrategy: "direct_only" })
      )
    })
  },
}

// "always" is the implicit default → renders nothing.
export const AlwaysHidden: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.adapterInstances.put(
        makeAdapterInstance({ id: ADAPTER_ID, atResponseStrategy: "always" })
      )
    })
  },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <AtStrategyChip {...args} />
    </div>
  ),
}
