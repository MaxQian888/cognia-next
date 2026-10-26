import type { Meta, StoryObj } from "@storybook/nextjs"

import { ToolSettingsSection } from "./tool-settings-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Settings page for the sidecar's built-in `cognia-tools` MCP server. Reads
// the settings store for the per-category enabled map, web-tools and
// self-invoke toggles. Storybook runs the WEB branch, so the sidecar category
// switches render disabled behind the "desktop required" alert, while the
// host-routed web/self-invoke cards stay interactive.
const meta = {
  title: "Settings/Tools/ToolSettingsSection",
  component: ToolSettingsSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAppSettings() })
  },
} satisfies Meta<typeof ToolSettingsSection>

export default meta
type Story = StoryObj<typeof meta>

// Defaults: web tools on, self-invoke tools off, sidecar categories disabled
// (web branch) behind the desktop-required alert.
export const Default: Story = {}

// A pre-upgrade shared preference is shown as inherited for both operations.
export const InheritedCogniaPreference: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({ webTools: { enabled: true, preferCognia: true } }),
    })
  },
}

// Keep native search while reading through Cognia Reader, without a search key.
export const IndependentOperationPreferences: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({
        webTools: { enabled: true, preferCogniaSearch: false, preferCogniaFetch: true },
      }),
    })
  },
}

// Web tools explicitly disabled → the card dims and operation controls collapse.
export const WebToolsOff: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({ webTools: { enabled: false, nativeOnAnthropic: false } }),
    })
  },
}
