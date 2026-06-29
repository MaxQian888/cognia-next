import type { Meta, StoryObj } from "@storybook/nextjs"

import { MySharesPanel } from "./my-shares-panel"
import { seedDb } from "@/lib/storybook/seed-db"
import type { SharedLinkRow } from "@/lib/db/shared-links"

const NOW = 1_700_000_000_000

function row(over: Partial<SharedLinkRow>): SharedLinkRow {
  return {
    id: `sl_${Math.random().toString(36).slice(2)}`,
    code: "abc123",
    kind: "chat-text",
    title: "Shared conversation",
    url: "https://share.example.com/s/abc123#key",
    createdAt: NOW,
    burnAfterRead: false,
    hasPassphrase: false,
    revoked: false,
    ...over,
  }
}

// Lists the share links the owner created (local Dexie mirror) with copy / open
// / revoke. The populated story seeds `sharedLinks`; the empty story shows the
// empty message.
const meta = {
  title: "Share/MySharesPanel",
  component: MySharesPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MySharesPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.sharedLinks.bulkPut([
        row({
          code: "abc123",
          kind: "chat-text",
          title: "Bug triage thread",
          expiresAt: NOW + 7 * 86_400_000,
        }),
        row({
          code: "def456",
          kind: "workflow-png",
          title: "Release workflow",
          burnAfterRead: true,
        }),
        row({ code: "ghi789", kind: "backup", title: "Settings backup", hasPassphrase: true }),
      ])
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
