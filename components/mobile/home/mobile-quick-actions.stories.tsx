import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MobileQuickActions } from "./mobile-quick-actions"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// Customizable quick-action grid on the mobile home. Reads the layout from
// `useSettingsStore` (defaults to the factory action set), so the reset store
// renders the default tiles. Tapping the Edit affordance opens the editor sheet.
const meta = {
  title: "Mobile/Home/MobileQuickActions",
  component: MobileQuickActions,
  parameters: { layout: "padded" },
  args: {
    onNewChat: fn(),
    onSearch: fn(),
  },
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
} satisfies Meta<typeof MobileQuickActions>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
