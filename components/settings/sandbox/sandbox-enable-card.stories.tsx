import type { Meta, StoryObj } from "@storybook/nextjs"

import { SandboxEnableCard } from "./sandbox-enable-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Store-reading: the switch reflects `settings.sandboxDefaultEnabled` (default
// false). Reset the settings store between stories.
function seed(sandboxDefaultEnabled?: boolean) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAppSettings({ sandboxDefaultEnabled }) })
  }
}

const meta = {
  title: "Settings/Sandbox/SandboxEnableCard",
  component: SandboxEnableCard,
  parameters: { layout: "padded" },
  beforeEach: seed(false),
  decorators: [
    (Story) => (
      <div className="w-[520px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SandboxEnableCard>

export default meta
type Story = StoryObj<typeof meta>

// Sandbox-by-default off (the shipped default).
export const Default: Story = {}

// Sandbox enabled by default for every session.
export const Enabled: Story = {
  beforeEach: seed(true),
}
