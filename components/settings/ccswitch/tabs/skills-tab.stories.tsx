import type { Meta, StoryObj } from "@storybook/nextjs"

import { CcswitchSkillsTab } from "./skills-tab"

// CCSwitch → Skills tab: lists the skills CCSwitch tracks. Tauri-backed;
// browser renders the desktop-only / empty state. No props.
const meta = {
  title: "Settings/CcSwitch/Tabs/SkillsTab",
  component: CcswitchSkillsTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CcswitchSkillsTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
