import type { Meta, StoryObj } from "@storybook/nextjs"

import { SourceVerificationSettings } from "./source-verification-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeSearchAppSettings,
  makeVerificationSettings,
} from "@/lib/storybook/fixtures/settings-search"

// `SourceVerificationSettings` edits the single `sourceVerificationSettings`
// object in `useSettingsStore` (mode, credibility threshold, toggles, trusted /
// blocked domains). When disabled, all sub-controls collapse; an auto-filter
// warning appears in "auto" mode with auto-filtering on.
const meta = {
  title: "Settings/Search/SourceVerificationSettings",
  component: SourceVerificationSettings,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeSearchAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SourceVerificationSettings>

export default meta
type Story = StoryObj<typeof meta>

// Default: enabled, "ask" mode, empty domain lists.
export const AskMode: Story = {}

export const Disabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        sourceVerificationSettings: makeVerificationSettings({ enabled: false }),
      }),
    })
  },
}

// Auto mode + auto-filter on + a high threshold → the amber filter warning shows.
export const AutoModeWithFilterWarning: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        sourceVerificationSettings: makeVerificationSettings({
          mode: "auto",
          autoFilterLowCredibility: true,
          minimumCredibilityScore: 0.7,
        }),
      }),
    })
  },
}

// Populated trusted/blocked domain lists in the domain management group.
export const WithDomainRules: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        sourceVerificationSettings: makeVerificationSettings({
          trustedDomains: ["nature.com", "who.int", "nih.gov"],
          blockedDomains: ["contentfarm.example", "spam.example"],
        }),
      }),
    })
  },
}
