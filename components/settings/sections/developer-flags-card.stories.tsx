import type { Meta, StoryObj } from "@storybook/nextjs"

import { DeveloperFlagsCard } from "./developer-flags-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"
import type { AppSettings } from "@cognia/agent-config-types"

// Store-reading: two developer toggles read from `settings.debugMode` and
// `settings.developer.chatMiddlewareExecution`. An unseeded store renders both
// off. Reset the settings store between stories.
function seed(over: Partial<AppSettings> = {}) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAppSettings(over) })
  }
}

const meta = {
  title: "Settings/Sections/DeveloperFlagsCard",
  component: DeveloperFlagsCard,
  parameters: { layout: "padded" },
  beforeEach: seed(),
  decorators: [
    (Story) => (
      <div className="w-[520px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DeveloperFlagsCard>

export default meta
type Story = StoryObj<typeof meta>

// Both flags off (the default).
export const Default: Story = {}

// Both developer flags enabled.
export const AllEnabled: Story = {
  beforeEach: seed({ debugMode: true, developer: { chatMiddlewareExecution: true } }),
}
