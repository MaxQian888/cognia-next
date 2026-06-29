import type { Meta, StoryObj } from "@storybook/nextjs"

import { AccountCard } from "./account-card"

// Live identity card for the /me header. Subscribes to the active Anthropic
// credential, the resolved user profile, and 5h/7d usage. In the Storybook
// browser there is no signed-in credential, so it renders the localized
// fallback identity (name + plan + "not signed in").
const meta = {
  title: "Mobile/Me/AccountCard",
  component: AccountCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AccountCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
