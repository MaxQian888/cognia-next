import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ProviderTabAnthropic } from "./provider-tab-anthropic"

// `ProviderTabAnthropic` composes the (keyring-backed, empty-in-browser) account
// list + preset picker with four inner panes (Overview / Account / Usage /
// Settings). The inner panes are `isTauri()`-gated, so in the Storybook browser
// each renders its "web mode" banner / signed-out empty state. `innerTab`
// selects which pane is active; `onInnerTabChange` is fired on tab clicks.
const meta = {
  title: "Settings/Subscription/ProviderTabAnthropic",
  component: ProviderTabAnthropic,
  args: {
    innerTab: "overview",
    onInnerTabChange: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProviderTabAnthropic>

export default meta
type Story = StoryObj<typeof meta>

export const Overview: Story = {}

export const Account: Story = {
  args: { innerTab: "account" },
}

export const Usage: Story = {
  args: { innerTab: "usage" },
}

export const Settings: Story = {
  args: { innerTab: "settings" },
}
