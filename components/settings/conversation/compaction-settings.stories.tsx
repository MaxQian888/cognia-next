import type { Meta, StoryObj } from "@storybook/nextjs"

import { CompactionSettings } from "./compaction-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Context-compaction controls wiring `AppSettings.compaction`. The Anthropic
// path self-manages compaction, so when the default provider is Anthropic most
// fields are disabled behind an explanatory notice; a generic provider unlocks
// the full strategy/trigger/threshold control set.
const meta = {
  title: "Settings/Conversation/CompactionSettings",
  component: CompactionSettings,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({ defaultProvider: "anthropic" }),
    })
  },
} satisfies Meta<typeof CompactionSettings>

export default meta
type Story = StoryObj<typeof meta>

// Anthropic default provider → fields disabled behind the self-manage notice.
export const AnthropicPath: Story = {}

// A generic provider unlocks every strategy/trigger/threshold control.
export const GenericProvider: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({
        defaultProvider: "openai",
        compaction: { enabled: true, strategy: "selective", trigger: "token-threshold" },
      }),
    })
  },
}

// Compaction disabled → only the master switch shows.
export const Disabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({ defaultProvider: "openai", compaction: { enabled: false } }),
    })
  },
}
