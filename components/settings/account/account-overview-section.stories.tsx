import type { Meta, StoryObj } from "@storybook/nextjs"

import { AccountOverviewSection } from "./account-overview-section"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAccountStore } from "@/stores/account/account-store"

// `AccountOverviewSection` is the desktop identity hub. It composes the neutral
// profile/identity hooks (user profile, Anthropic credential + usage, companion
// config) over `useAccountStore`. With the store reset to its initial state it
// renders the unauthenticated/empty identity surface plus the profile editor.
const meta = {
  title: "Settings/Account/AccountOverviewSection",
  component: AccountOverviewSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useAccountStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AccountOverviewSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
