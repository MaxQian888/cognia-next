import type { Meta, StoryObj } from "@storybook/nextjs"

import { PersonalizationCard } from "./personalization-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"
import { useSettingsStore } from "@/stores/settings"

// `PersonalizationCard` (Settings → Appearance) is propless — it subscribes to
// `useSettingsStore` for the display name, welcome style, and the
// "restore hidden sections" escape hatch. Reset the store between stories so
// one story's seeded settings don't bleed into the next.
const meta = {
  title: "Settings/PersonalizationCard",
  component: PersonalizationCard,
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
} satisfies Meta<typeof PersonalizationCard>

export default meta
type Story = StoryObj<typeof meta>

// No settings row yet — falls back to the "rich" welcome style and an empty name.
export const Default: Story = {}

export const WithName: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({ userName: "Ada Lovelace", welcomeStyle: "rich" }),
    })
  },
}

export const MinimalStyle: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({ userName: "Grace", welcomeStyle: "minimal" }),
    })
  },
}

// `welcomeHidden.tryPrompt` toggles the "restore hidden sections" button on.
export const WithHiddenSections: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({ welcomeStyle: "rich", welcomeHidden: { tryPrompt: true } }),
    })
  },
}
