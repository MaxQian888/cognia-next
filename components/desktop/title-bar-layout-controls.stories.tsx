import type { Meta, StoryObj } from "@storybook/nextjs"

import { TitleBarLayoutControls } from "./title-bar-layout-controls"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useUIStore } from "@/stores/ui/ui-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

// Title-bar layout toggle cluster (guild rail / sidebar / terminal) + a
// "Customize Layout" dropdown. Subscribes to the UI + terminal stores internally,
// so reset both between stories.
const meta = {
  title: "Desktop/TitleBarLayoutControls",
  component: TitleBarLayoutControls,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStores(useUIStore, useTerminalStore)
  },
} satisfies Meta<typeof TitleBarLayoutControls>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
