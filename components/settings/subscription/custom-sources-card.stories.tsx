import type { Meta, StoryObj } from "@storybook/nextjs"

import { CustomSourcesCard } from "./custom-sources-card"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// `CustomSourcesCard` reads `customLimitsSources` from the settings store but
// gates the editor behind `isTauri()`. In the Storybook (non-Tauri) browser it
// renders the "web mode" hint card explaining the desktop requirement. Reset
// the settings store between stories so prior story state can't leak in.
const meta = {
  title: "Settings/Subscription/CustomSourcesCard",
  component: CustomSourcesCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof CustomSourcesCard>

export default meta
type Story = StoryObj<typeof meta>

// Browser renders the desktop-only "web mode" hint (the editor needs Tauri).
export const WebMode: Story = {}
