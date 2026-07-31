import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AccountManageDialog } from "./account-manage-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useAccountStore } from "@/stores/account/account-store"
import { makeAccountSet } from "@/lib/storybook/fixtures/account"

const accounts = makeAccountSet()

// Manage-accounts dialog: create, rename, change-password, delete. Reads the
// account store, so the Open story seeds a few accounts.
const meta = {
  title: "Account/AccountManageDialog",
  component: AccountManageDialog,
  args: { open: true, onOpenChange: fn() },
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useAccountStore)
    seedStore(useAccountStore, {
      accounts,
      activeAccountId: accounts[0].id,
      unlockedAccountId: accounts[0].id,
      loaded: true,
    })
  },
} satisfies Meta<typeof AccountManageDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = {
  args: { open: false },
}
