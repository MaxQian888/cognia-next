import type { Meta, StoryObj } from "@storybook/nextjs"

import { SttCard } from "./stt-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"

// `SttCard` reads `sttLanguage` / `selectedMicId` from the settings store and
// detects Web Speech API support + microphones at mount. Reset between stories
// so a seeded language doesn't leak.
const meta = {
  title: "Settings/Speech/SttCard",
  component: SttCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: {} as unknown as AppSettings })
  },
} satisfies Meta<typeof SttCard>

export default meta
type Story = StoryObj<typeof meta>

// Default language (en-US) + system-default microphone.
export const Default: Story = {}

// A non-default language pre-selected.
export const ChineseSelected: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: { sttLanguage: "zh-CN" } as unknown as AppSettings,
    })
  },
}
