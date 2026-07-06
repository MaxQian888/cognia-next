import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinDraftsPanel } from "./twin-drafts-panel"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeTwinDraft } from "@/lib/storybook/fixtures/mobile-discover"

// Swipe-to-accept/reject list of pending twin drafts (newest first), read live
// from the `twinDrafts` Dexie table. The empty DB renders nothing (the caller
// owns the empty state); the seeded story shows the swipeable rows.
const meta = {
  title: "Mobile/Discover/TwinDraftsPanel",
  component: TwinDraftsPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinDraftsPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Pending: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.twinDrafts.bulkPut([
        makeTwinDraft({ id: "d1", status: "pending" }),
        makeTwinDraft({
          id: "d2",
          status: "pending",
          kind: "skill",
          payload: {
            kind: "skill",
            data: { name: "Inbox triage", description: "Sort overnight mail into 3 buckets." },
          },
        }),
      ])
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
