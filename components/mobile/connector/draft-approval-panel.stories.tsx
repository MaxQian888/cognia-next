import type { Meta, StoryObj } from "@storybook/nextjs"

import { DraftApprovalPanel } from "./draft-approval-panel"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeConnectorDraft } from "@/lib/storybook/fixtures/inbox"

// Connector draft triage list (swipe / tap approve-reject). Reads pending
// `connectorDrafts` live from Dexie. Empty DB → empty state; the seeded story
// inserts a few pending drafts to triage.
const meta = {
  title: "Mobile/Connector/DraftApprovalPanel",
  component: DraftApprovalPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[640px] w-[390px] overflow-y-auto border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DraftApprovalPanel>

export default meta
type Story = StoryObj<typeof meta>

/** Nothing pending — the empty state. */
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

/** Several pending drafts awaiting approval. */
export const WithDrafts: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorDrafts.bulkPut([
        makeConnectorDraft({
          conversationKey: "slack:#support",
          segments: [{ type: "text", text: "Thanks for reaching out — I've reset your token." }],
        }),
        makeConnectorDraft({
          conversationKey: "telegram:dm",
          segments: [{ type: "text", text: "Your backup completed successfully overnight." }],
        }),
      ])
    })
  },
}
