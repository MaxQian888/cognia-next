import type { Meta, StoryObj } from "@storybook/nextjs"

import { CcswitchSyncTab } from "./sync-tab"

// CCSwitch → Sync tab: data-directory resolution + default-propagation config.
// Tauri-gated (`tabReady = isTauri()`); browser renders the desktop-only
// state. No props.
const meta = {
  title: "Settings/CcSwitch/Tabs/SyncTab",
  component: CcswitchSyncTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CcswitchSyncTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
