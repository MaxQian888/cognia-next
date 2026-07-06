import type { Meta, StoryObj } from "@storybook/nextjs"

import { AccountSwitcher } from "./account-switcher"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useAccountStore } from "@/stores/account/account-store"
import { makeAccountSet } from "@/lib/storybook/fixtures/account"

const accounts = makeAccountSet()

// Sidebar avatar button that opens a popover to switch / lock / manage local
// accounts. Reads the account store; renders nothing when there are no accounts.
const meta = {
  title: "Account/AccountSwitcher",
  component: AccountSwitcher,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AccountSwitcher>

export default meta
type Story = StoryObj<typeof meta>

export const WithAccounts: Story = {
  beforeEach: () => {
    resetStore(useAccountStore)
    seedStore(useAccountStore, {
      accounts,
      activeAccountId: accounts[0].id,
      unlockedAccountId: accounts[0].id,
      loaded: true,
    })
  },
}

// No accounts → the switcher renders nothing.
export const NoAccountsHidden: Story = {
  beforeEach: () => {
    resetStore(useAccountStore)
    seedStore(useAccountStore, { loaded: true })
  },
  render: () => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <AccountSwitcher />
    </div>
  ),
}
