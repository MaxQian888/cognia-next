import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ChangedSettingsDialog } from "./changed-settings-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Diffs the current settings against the canonical DEFAULTS and lists every
// divergence grouped by owning section, with per-row / per-group / reset-all
// affordances. Reads the settings store.
const meta = {
  title: "Settings/Actions/ChangedSettingsDialog",
  component: ChangedSettingsDialog,
  parameters: { layout: "centered" },
  args: { open: true, onOpenChange: fn() },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof ChangedSettingsDialog>

export default meta
type Story = StoryObj<typeof meta>

// A near-default profile → "nothing changed" empty state.
export const NoChanges: Story = {}

// Several keys diverge from defaults → grouped change list with reset actions.
export const WithChanges: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({
        defaultProvider: "openai",
        streamPartialMessages: false,
        permissionMode: "acceptEdits",
      }),
    })
  },
}
