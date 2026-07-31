import type { Meta, StoryObj } from "@storybook/nextjs"

import { LimitsMetersCard } from "./limits-meters-card"

// `LimitsMetersCard` reads its snapshot through `useProviderLimits`, backed by
// the Tauri keyring + authed GET. In the Storybook (non-Tauri) browser the hook
// resolves to its empty / unavailable branch, so the card renders the "no
// meters yet" shell plus the manual Refresh button. `now` is the render clock
// the parent ticks once a minute for reset countdowns.
const meta = {
  title: "Settings/Subscription/LimitsMetersCard",
  component: LimitsMetersCard,
  args: {
    provider: "codex",
    accountId: "acc-codex-1",
    label: "ChatGPT Plus",
    now: Date.UTC(2026, 5, 1, 12, 0, 0),
    windowsOnly: false,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof LimitsMetersCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const OpenCodeAccount: Story = {
  args: { provider: "opencode", accountId: "acc-opencode-1", label: "OpenCode Go" },
}

// In windows-only mode a credit-only / not-yet-fetched account renders nothing
// at all (the sibling BalanceCard owns those), so this story renders empty.
export const WindowsOnly: Story = {
  args: { windowsOnly: true },
}
