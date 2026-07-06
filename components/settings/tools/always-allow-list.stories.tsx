import type { Meta, StoryObj } from "@storybook/nextjs"

import { AlwaysAllowList } from "./always-allow-list"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Reads `settings.alwaysAllowTools` from the settings store. Empty list →
// italic empty-state copy; a populated list renders one removable badge row
// per tool.
const meta = {
  title: "Settings/Tools/AlwaysAllowList",
  component: AlwaysAllowList,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAppSettings({ alwaysAllowTools: [] }) })
  },
} satisfies Meta<typeof AlwaysAllowList>

export default meta
type Story = StoryObj<typeof meta>

// No tools approved yet.
export const Empty: Story = {}

// Several always-allowed tools, each with a remove button.
export const Populated: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({
        alwaysAllowTools: ["Bash", "Read", "Edit", "mcp__github__create_issue", "WebFetch"],
      }),
    })
  },
}
