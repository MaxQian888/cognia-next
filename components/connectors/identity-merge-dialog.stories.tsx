import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { IdentityMergeDialog } from "./identity-merge-dialog"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"

function identity(over: Partial<PlatformIdentityRow>): PlatformIdentityRow {
  return {
    id: "id_a",
    platform: "telegram",
    adapterId: "tg-1",
    remoteUserId: "12345",
    displayName: "Ada (Telegram)",
    lastSeenAt: 1_700_000_000_000,
    ...over,
  }
}

const identities: [PlatformIdentityRow, PlatformIdentityRow] = [
  identity({ id: "id_a", platform: "telegram", displayName: "Ada (Telegram)" }),
  identity({ id: "id_b", platform: "discord", adapterId: "dc-1", displayName: "Ada (Discord)" }),
]

// Identity merge dialog: pick a primary, then merge the secondary into it. The
// merge call hits Dexie, so this story exercises the layout/selection only.
const meta = {
  title: "Connectors/IdentityMergeDialog",
  component: IdentityMergeDialog,
  args: { open: true, onOpenChange: fn(), onMerged: fn(), identities },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof IdentityMergeDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = {
  args: { open: false },
}
