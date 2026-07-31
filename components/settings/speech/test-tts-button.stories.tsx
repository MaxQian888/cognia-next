import type { Meta, StoryObj } from "@storybook/nextjs"

import { TestTtsButton } from "./test-tts-button"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

// `TestTtsButton` drives the `useTTS` hook (idle → Play, loading → spinner,
// playing → Stop). At rest it renders the Play affordance with the
// language-aware sample picked from `settings.sttLanguage`.
const meta = {
  title: "Settings/Speech/TestTtsButton",
  component: TestTtsButton,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: { sttLanguage: "en-US" } as unknown as AppSettings,
    })
  },
} satisfies Meta<typeof TestTtsButton>

export default meta
type Story = StoryObj<typeof meta>

// Idle button using the active settings voice and a language-aware sample.
export const Default: Story = {}

// An explicit sample line overrides the language-aware default.
export const WithSampleText: Story = {
  args: { sampleText: "The quick brown fox jumps over the lazy dog." },
}

// A per-character voice overlay auditioned without touching global settings.
export const WithVoiceOverlay: Story = {
  args: { voiceOverlay: { ttsProvider: "openai", openaiVoice: "nova" } },
}
