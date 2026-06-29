import type { Meta, StoryObj } from "@storybook/nextjs"

import { CcswitchOverviewTab } from "./overview-tab"

// CCSwitch → Overview tab: resolved DB path, counts, and provider summary.
// Tauri-backed via the CCSwitch hooks; the browser renders the desktop-only /
// empty state. No props.
const meta = {
  title: "Settings/CcSwitch/Tabs/OverviewTab",
  component: CcswitchOverviewTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CcswitchOverviewTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
