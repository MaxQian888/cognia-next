import type { Meta, StoryObj } from "@storybook/nextjs"

import { AccountBarButton } from "./account-bar-button"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useAccountStore } from "@/stores/account/account-store"

// Compact account control shared by the title/status bars. Seeds one local
// account so the trigger shows its initial; the popover offers lock + manage.
const meta = {
  title: "Account/AccountBarButton",
  component: AccountBarButton,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStores(useAccountStore)
    useAccountStore.setState({
      accounts: [{ id: "a1", displayName: "Ada Lovelace" }] as never,
      activeAccountId: "a1",
    })
  },
  decorators: [
    (Story) => (
      <div className="flex h-6 items-center border-t bg-muted/40 text-[11px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AccountBarButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
