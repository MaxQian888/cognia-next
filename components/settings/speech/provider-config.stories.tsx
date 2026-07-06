import type { Meta, StoryObj } from "@storybook/nextjs"

import {
  CartesiaConfig,
  EdgeConfig,
  ElevenLabsConfig,
  GeminiConfig,
  OpenAiConfig,
  OpenAiRealtimeConfig,
  SystemConfig,
} from "./provider-config"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"

// The per-provider config panels each read their sub-slice of `AppSettings`
// from the settings store and fall back to sensible defaults, so an empty
// `settings: {}` renders the default selection. Reset between stories so a
// seeded value or API key doesn't leak across panels.
const meta = {
  title: "Settings/Speech/ProviderConfig",
  component: OpenAiConfig,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: {} as unknown as AppSettings })
  },
} satisfies Meta<typeof OpenAiConfig>

export default meta
type Story = StoryObj<typeof meta>

// OpenAI: voice + model + audio-format selects, speed slider, and (for the
// gpt-4o-mini-tts model) the voice-instructions textarea.
export const OpenAI: Story = {}

// gpt-4o-mini-tts model already seeded → voice-instructions textarea visible.
export const OpenAIWithInstructions: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: {
        openaiModel: "gpt-4o-mini-tts",
        openaiInstructions: "Speak warmly and slowly.",
      } as unknown as AppSettings,
    })
  },
}

export const Gemini: Story = {
  render: () => <GeminiConfig />,
}

export const Edge: Story = {
  render: () => <EdgeConfig />,
}

export const ElevenLabs: Story = {
  render: () => <ElevenLabsConfig />,
}

export const Cartesia: Story = {
  render: () => <CartesiaConfig />,
}

// System (Web Speech API) — voice list is populated from the browser.
export const System: Story = {
  render: () => <SystemConfig />,
}

// OpenAI Realtime — shows the "desktop only" notice on the web shell.
export const OpenAiRealtime: Story = {
  render: () => <OpenAiRealtimeConfig />,
}
