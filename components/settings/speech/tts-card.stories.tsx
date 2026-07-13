import type { Meta, StoryObj } from "@storybook/nextjs"

import { TtsCard } from "./tts-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

// `TtsCard` reads the full TTS slice of `AppSettings`. When `ttsEnabled` is
// false it collapses to the master toggle; enabling it reveals the provider
// switch, the provider-specific panel, the rate/pitch/volume sliders, the
// auto-play / cache / streaming / fallback toggles, and the SSML +
// pronunciation-dictionary sections. Reset between stories so the enabled
// state doesn't leak.
const meta = {
  title: "Settings/Speech/TtsCard",
  component: TtsCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: { ttsEnabled: false } as unknown as AppSettings,
    })
  },
} satisfies Meta<typeof TtsCard>

export default meta
type Story = StoryObj<typeof meta>

// Master toggle off → only the enable switch is shown.
export const Disabled: Story = {}

// Enabled with the System (Web Speech) provider → shows the SSML preview.
export const EnabledSystem: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: { ttsEnabled: true, ttsProvider: "system" } as unknown as AppSettings,
    })
  },
}

// Enabled with the OpenAI provider → renders the OpenAI config sub-panel.
export const EnabledOpenAi: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: { ttsEnabled: true, ttsProvider: "openai" } as unknown as AppSettings,
    })
  },
}
