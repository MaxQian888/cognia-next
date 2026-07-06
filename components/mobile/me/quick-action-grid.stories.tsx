import type { Meta, StoryObj } from "@storybook/nextjs"

import { QuickActionGrid } from "./quick-action-grid"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"

// 4-tile quick actions (theme / language / computer-use / scan). Reads
// `useSettingsStore` for the language + computer-use state and next-themes
// (provided by the preview) for the theme tile.
const meta = {
  title: "Mobile/Me/QuickActionGrid",
  component: QuickActionGrid,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof QuickActionGrid>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const ComputerUseEnabled: Story = {
  beforeEach: () => {
    useSettingsStore.setState({
      settings: { mobileComputerUseEnabled: true } as unknown as AppSettings,
    })
  },
}
