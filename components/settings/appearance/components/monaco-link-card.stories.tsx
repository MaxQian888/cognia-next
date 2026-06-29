import type { Meta, StoryObj } from "@storybook/nextjs"

import { MonacoLinkCard } from "./monaco-link-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Controls whether the app theme drives the Monaco/Canvas editor, with an
// optional locked editor theme. Reads the flattened `monacoLink` store field
// (always defined, defaulted from DEFAULT_MONACO_LINK).
const meta = {
  title: "Settings/Appearance/MonacoLinkCard",
  component: MonacoLinkCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof MonacoLinkCard>

export default meta
type Story = StoryObj<typeof meta>

// Default link settings.
export const Default: Story = {}
