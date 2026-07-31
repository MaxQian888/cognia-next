import type { Meta, StoryObj } from "@storybook/nextjs"

import { SandboxTierCard } from "./sandbox-tier-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Store-reading: the default-tier radio reflects `settings.sandboxTier`
// (defaulting to "os"). Reset the settings store between stories so a prior
// selection can't leak in.
function seed(sandboxTier?: "os" | "microvm") {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAppSettings({ sandboxTier }) })
  }
}

const meta = {
  title: "Settings/Sandbox/SandboxTierCard",
  component: SandboxTierCard,
  parameters: { layout: "padded" },
  beforeEach: seed("os"),
  decorators: [
    (Story) => (
      <div className="w-[520px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SandboxTierCard>

export default meta
type Story = StoryObj<typeof meta>

// OS-level confinement (the default).
export const Default: Story = {}

// MicroVM tier selected.
export const MicroVm: Story = {
  beforeEach: seed("microvm"),
}
