import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileSettingsPanel } from "./mobile-settings-panel"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// Mobile settings panel (theme / language / font scale / default model +
// biometric guards). Propless: reads `useSettingsStore`. With no settings
// loaded it falls back to sane defaults (system theme, en, md). The store is
// reset between stories so edits don't leak across renders.
const meta = {
  title: "Mobile/Settings/MobileSettingsPanel",
  component: MobileSettingsPanel,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileSettingsPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
