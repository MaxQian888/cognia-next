import type { Meta, StoryObj } from "@storybook/nextjs"

import { CcswitchSection } from "./ccswitch-section"

// CCSwitch settings shell (overview / providers / prompts / mcp / skills /
// sync tabs). The tabs read CCSwitch state through Tauri-backed hooks; in the
// browser those resolve to empty / desktop-only states. Active tab is
// URL-driven; App Router mocks default it to the overview tab.
const meta = {
  title: "Settings/CcSwitch/CcswitchSection",
  component: CcswitchSection,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CcswitchSection>

export default meta
type Story = StoryObj<typeof meta>

// Web branch: overview tab active, desktop-only / empty states.
export const Default: Story = {}
