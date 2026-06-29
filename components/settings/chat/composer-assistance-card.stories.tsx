import type { Meta, StoryObj } from "@storybook/nextjs"

import { ComposerAssistanceCard } from "./composer-assistance-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"

// `ComposerAssistanceCard` reads the optional `composerAssistance` block from
// the settings store: prompt enhancement, ghost-text autocomplete (+ debounce
// input, only shown when ghost-text is on), and starter/follow-up suggestions.
function seedSettings(patch: Partial<AppSettings>) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: patch as unknown as AppSettings })
  }
}

const meta = {
  title: "Settings/Chat/ComposerAssistanceCard",
  component: ComposerAssistanceCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ComposerAssistanceCard>

export default meta
type Story = StoryObj<typeof meta>

// No stored block — enhance + suggestions default on, ghost-text off.
export const Default: Story = {}

// Ghost-text enabled — surfaces the debounce input.
export const GhostTextEnabled: Story = {
  beforeEach: seedSettings({
    composerAssistance: {
      enhance: { enabled: true },
      ghostText: { enabled: true, debounceMs: 750 },
      suggestions: { starters: true, followUps: true },
    },
  } as unknown as Partial<AppSettings>),
}
