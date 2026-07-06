import type { Meta, StoryObj } from "@storybook/nextjs"

import { BalanceCard } from "./balance-card"

// `BalanceCard` reads its snapshot through `useAccountBalance`, which is backed
// by the Tauri keyring + `subscription_authed_get`. In the Storybook (non-Tauri)
// browser there is no backend, so the hook resolves to its empty / unavailable
// branch and the card renders the "no balance yet" shell plus the manual
// Refresh button. The stories vary the account identity so the header label and
// per-account testids differ.
const meta = {
  title: "Settings/Subscription/BalanceCard",
  component: BalanceCard,
  args: {
    provider: "codex",
    accountId: "acc-codex-1",
    label: "ChatGPT Plus",
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof BalanceCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const OpenCodeAccount: Story = {
  args: { provider: "opencode", accountId: "acc-opencode-1", label: "OpenCode Zen" },
}

// Without an explicit label the card falls back to the account id in its header.
export const NoLabel: Story = {
  args: { provider: "codex", accountId: "acc-codex-unlabeled", label: undefined },
}
