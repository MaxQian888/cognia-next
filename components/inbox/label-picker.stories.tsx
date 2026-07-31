import type { Meta, StoryObj } from "@storybook/nextjs"

import { LabelPicker } from "./label-picker"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeConversationLabel } from "@/lib/storybook/fixtures/inbox"

const CONVERSATION_KEY = "slack:adapter-1:C1"

// `LabelPicker` reads the label catalog live (`useConversationLabels`) and
// renders the conversation's selected labels as removable chips + a "＋"
// dropdown of the full catalog. Seed the catalog so both render.
const meta = {
  title: "Inbox/LabelPicker",
  component: LabelPicker,
  args: { conversationKey: CONVERSATION_KEY, sessionId: "ses_1", selectedIds: [] },
  parameters: { layout: "padded" },
} satisfies Meta<typeof LabelPicker>

export default meta
type Story = StoryObj<typeof meta>

const seedCatalog = () =>
  seedDb(async (db) => {
    await db.conversationLabels.bulkPut([
      makeConversationLabel({ id: "lbl-followup", name: "follow-up", color: "#f59e0b" }),
      makeConversationLabel({ id: "lbl-vip", name: "vip", color: "#7c3aed" }),
      makeConversationLabel({ id: "lbl-bug", name: "bug", color: "#ef4444" }),
    ])
  })

export const NoneSelected: Story = {
  beforeEach: seedCatalog,
}

export const WithSelected: Story = {
  args: { selectedIds: ["lbl-followup", "lbl-vip"] },
  beforeEach: seedCatalog,
}

// Empty catalog → the dropdown shows the "no labels yet" hint.
export const EmptyCatalog: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
