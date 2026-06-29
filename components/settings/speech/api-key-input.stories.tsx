import type { Meta, StoryObj } from "@storybook/nextjs"

import { ApiKeyInput } from "./api-key-input"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// `ApiKeyInput` reads the stored key from `useSettingsStore.providerKeys[provider]`
// and renders the "configured" badge + Clear button only when a key is present.
// Reset the store each story so a seeded key never leaks into the empty case.
const meta = {
  title: "Settings/Speech/ApiKeyInput",
  component: ApiKeyInput,
  args: { provider: "openai", label: "OpenAI", placeholder: "sk-…" },
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof ApiKeyInput>

export default meta
type Story = StoryObj<typeof meta>

// No stored key → "not configured" badge, Save disabled (draft is empty), no Clear.
export const NotConfigured: Story = {}

// A key is stored → "configured" badge + Clear button; the input is pre-filled
// (masked) and Save stays disabled until the draft diverges.
export const Configured: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { providerKeys: { openai: "sk-demo-configured-key" } })
  },
}

// A different provider with its own placeholder.
export const ElevenLabs: Story = {
  args: { provider: "elevenlabs", label: "ElevenLabs", placeholder: "sk_…" },
}
