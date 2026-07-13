import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RoutingPresetPreviewDialog } from "./routing-preset-preview-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeProviderSettingsMap } from "@/lib/storybook/fixtures/settings-provider"
import { BUILT_IN_PRESETS } from "@cognia/provider-routing/built-in-presets"
import type { AppSettings } from "@cognia/agent-config-types"

// Preview-before-apply dialog for a built-in routing preset: shows alias chains
// adapted to currently-enabled providers, a merge/overwrite choice, and the
// revertible note. Reads settings to compute the adapted chains. Authored OPEN.
const seedProviders = (providerSettings: AppSettings["providerSettings"]) => () => {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, { settings: { providerSettings } as AppSettings })
}

const meta = {
  title: "Settings/Provider/Routing/RoutingPresetPreviewDialog",
  component: RoutingPresetPreviewDialog,
  parameters: { layout: "fullscreen" },
  beforeEach: seedProviders(makeProviderSettingsMap()),
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof RoutingPresetPreviewDialog>

export default meta
type Story = StoryObj<typeof meta>

// The budget preset previewed against a healthy set of enabled providers.
export const BudgetPreset: Story = {
  args: { preset: BUILT_IN_PRESETS[0] },
}

// The performance preset previewed.
export const PerformancePreset: Story = {
  args: { preset: BUILT_IN_PRESETS[1] },
}

// No providers enabled — the adapted chain list is empty, apply disabled.
export const NoEnabledProviders: Story = {
  beforeEach: seedProviders({}),
  args: { preset: BUILT_IN_PRESETS[0] },
}
