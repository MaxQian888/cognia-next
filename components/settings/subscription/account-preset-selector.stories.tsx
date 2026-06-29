import type { Meta, StoryObj } from "@storybook/nextjs"

import { AccountPresetSelector } from "./account-preset-selector"

// `AccountPresetSelector` lazily loads the provider's preset library + the
// account's current binding inside an `isTauri()`-gated effect. In the
// Storybook (non-Tauri) browser the effect returns early, the preset list stays
// empty, and the component renders `null` (it only shows the <Select> once at
// least one preset exists). These stories therefore document the props surface
// and verify the component mounts cleanly in the web branch.
const meta = {
  title: "Settings/Subscription/AccountPresetSelector",
  component: AccountPresetSelector,
  args: {
    provider: "anthropic",
    accountId: "acc-anthropic-1",
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof AccountPresetSelector>

export default meta
type Story = StoryObj<typeof meta>

export const Anthropic: Story = {}

export const Codex: Story = {
  args: { provider: "codex", accountId: "acc-codex-1" },
}

export const OpenCode: Story = {
  args: { provider: "opencode", accountId: "acc-opencode-1" },
}
