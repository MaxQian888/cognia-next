import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinDraftsTab } from "./twin-drafts-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeTwinDraft } from "@/lib/storybook/fixtures/twin"

// Dexie-backed: `useLiveQuery(listTwinDraftsByTwin)` reads the `twinDrafts`
// table. Default renders the empty review queue; the seeded story inserts
// pending/accepted drafts.
const TWIN_ID = "twin-1"

const meta = {
  title: "Twin/Tabs/DraftsTab",
  component: TwinDraftsTab,
  parameters: { layout: "fullscreen" },
  args: { twinId: TWIN_ID },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinDraftsTab>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const WithDrafts: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.twinDrafts.bulkPut([
        makeTwinDraft({ twinId: TWIN_ID, status: "pending" }),
        makeTwinDraft({
          twinId: TWIN_ID,
          kind: "skill",
          status: "pending",
          payload: {
            kind: "skill",
            data: {
              name: "Refund Workflow",
              description: "Steps to process a refund.",
              content: "# Refund\n",
            },
          },
        }),
        makeTwinDraft({ twinId: TWIN_ID, status: "accepted", acceptedAsId: "char-1" }),
      ])
    })
  },
}
