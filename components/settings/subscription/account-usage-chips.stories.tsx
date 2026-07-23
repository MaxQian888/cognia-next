import type { Meta, StoryObj } from "@storybook/nextjs"

import { AccountUsageChips } from "./account-usage-chips"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeCharacter, makeChatSession } from "@/lib/storybook/fixtures/settings-subscription"

const ACCOUNT_ID = "acc-story-anthropic-1"

// `AccountUsageChips` reads `listCharacters()` / `listSessions()` from Dexie via
// `useLiveQuery` and renders a chip for each character/session pinned to the
// account id. With no matching rows it renders `null` (the Empty story shows
// that branch); the populated stories seed matching rows.
const meta = {
  title: "Settings/Subscription/AccountUsageChips",
  component: AccountUsageChips,
  args: { accountId: ACCOUNT_ID, usage: undefined },
  parameters: { layout: "padded" },
} satisfies Meta<typeof AccountUsageChips>

export default meta
type Story = StoryObj<typeof meta>

// No rows reference the account → the component renders nothing.
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

// A character pinned to the account surfaces an "in use by character" chip.
export const PinnedCharacter: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.characters.bulkPut([
        makeCharacter({ name: "Research Analyst", accountIdOverride: ACCOUNT_ID }),
      ])
    })
  },
}

// Both a character and several sessions pinned to the same account.
export const CharacterAndSessions: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.characters.bulkPut([
        makeCharacter({ name: "Code Reviewer", accountIdOverride: ACCOUNT_ID }),
      ])
      await db.sessions.bulkPut([
        makeChatSession({ title: "Refactor billing module", accountId: ACCOUNT_ID }),
        makeChatSession({ title: "Draft release notes", accountId: ACCOUNT_ID }),
      ])
    })
  },
}
