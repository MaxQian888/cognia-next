import type { Meta, StoryObj } from "@storybook/nextjs"

import { CcswitchPromptsTab } from "./prompts-tab"

// CCSwitch → Prompts tab: lists the prompts CCSwitch tracks. Tauri-backed;
// browser renders the desktop-only / empty state. No props.
const meta = {
  title: "Settings/CcSwitch/Tabs/PromptsTab",
  component: CcswitchPromptsTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CcswitchPromptsTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
