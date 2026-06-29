import type { Meta, StoryObj } from "@storybook/nextjs"

import {
  SettingsSaveIndicator,
  markSettingsSaved,
  __resetSettingsSaveTrackerForTesting,
} from "./settings-save-indicator"

const meta = {
  title: "Agent/Workspace/Settings/SettingsSaveIndicator",
  component: SettingsSaveIndicator,
  args: { teamId: "team-1" },
  beforeEach: () => {
    __resetSettingsSaveTrackerForTesting()
  },
} satisfies Meta<typeof SettingsSaveIndicator>

export default meta
type Story = StoryObj<typeof meta>

// Nothing persisted yet → "unsaved" badge.
export const Unsaved: Story = {}

// A recent save → "saved just now" badge.
export const Saved: Story = {
  decorators: [
    (Story) => {
      markSettingsSaved()
      return <Story />
    },
  ],
}
