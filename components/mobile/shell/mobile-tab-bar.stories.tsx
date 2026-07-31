import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileTabBar } from "./mobile-tab-bar"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// WeChat-style bottom tab bar (聊天 / 工作流 / 发现 / 我). Resolves the visible
// tab order from `useSettingsStore` (factory default after reset) and the active
// tab from the router pathname (App Router mock). It is `fixed inset-x-0
// bottom-0`, so the decorator gives it a positioned phone-sized frame.
const meta = {
  title: "Mobile/Shell/MobileTabBar",
  component: MobileTabBar,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="relative mx-auto h-[200px] w-[390px] overflow-hidden border bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileTabBar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithBadges: Story = {
  args: {
    badges: { chat: 3, workflows: 12 },
  },
}

export const HighBadgeCount: Story = {
  args: {
    badges: { chat: 142 },
  },
}
