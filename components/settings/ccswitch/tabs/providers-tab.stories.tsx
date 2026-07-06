import type { Meta, StoryObj } from "@storybook/nextjs"

import { CcswitchProvidersTab } from "./providers-tab"

// CCSwitch → Providers tab: lists CCSwitch providers with a "switch to" action
// that opens the propagation dialog. Tauri-backed; browser renders the
// desktop-only / empty state. No props.
const meta = {
  title: "Settings/CcSwitch/Tabs/ProvidersTab",
  component: CcswitchProvidersTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CcswitchProvidersTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
