import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ProviderImportExport } from "./provider-import-export"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeProviderSettingsMap,
  makeCustomProviderSettings,
} from "@/lib/storybook/fixtures/settings-provider"

// Export/Import trigger pair. Reads the FLAT `providerSettings` (record) and
// `customProviders` (array) so the Export dialog can list selectable providers.
// The dialogs themselves open on click — the seed determines what they contain.
const meta = {
  title: "Settings/Provider/ProviderImportExport",
  component: ProviderImportExport,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  args: { onClose: fn() },
} satisfies Meta<typeof ProviderImportExport>

export default meta
type Story = StoryObj<typeof meta>

// No configured providers — the Export dialog would list nothing.
export const Default: Story = {}

// Several built-in providers plus a custom gateway — the Export dialog lists
// them all with model counts.
export const WithConfiguredProviders: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      providerSettings: makeProviderSettingsMap(),
      customProviders: [makeCustomProviderSettings({ id: "my-gateway", customName: "My Gateway" })],
    })
  },
}
