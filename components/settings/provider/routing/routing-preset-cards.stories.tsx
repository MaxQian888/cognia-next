import type { Meta, StoryObj } from "@storybook/nextjs"

import { RoutingPresetCards } from "./routing-preset-cards"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeProviderSettingsMap,
  makeRoutingConfig,
} from "@/lib/storybook/fixtures/settings-provider"
import { BUILT_IN_PRESETS } from "@cognia/provider-routing/built-in-presets"
import type { RoutingPresetsState } from "@cognia/provider-types/routing-presets"
import type { AppSettings } from "@cognia/agent-config-types"

// One-click preset activation cards (Budget / Performance / Reliability) and the
// revert affordance. Reads `settings.routingPresets`; the preview dialog reads
// the wider settings to adapt chains to currently-enabled providers.
const seedPresets = (routingPresets: RoutingPresetsState) => () => {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, {
    settings: { routingPresets, providerSettings: makeProviderSettingsMap() } as AppSettings,
  })
}

const EMPTY: RoutingPresetsState = {
  customPresets: [],
  activePresetId: null,
  preActivationSnapshot: null,
}

const meta = {
  title: "Settings/Provider/Routing/RoutingPresetCards",
  component: RoutingPresetCards,
  parameters: { layout: "padded" },
  beforeEach: seedPresets(EMPTY),
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RoutingPresetCards>

export default meta
type Story = StoryObj<typeof meta>

// No preset active — three preview cards, no active badge, no revert.
export const NoneActive: Story = {}

// The first built-in preset marked active (shows the "active" badge).
export const ActivePreset: Story = {
  beforeEach: seedPresets({ ...EMPTY, activePresetId: BUILT_IN_PRESETS[0]!.id }),
}

// Active preset with a pre-activation snapshot present → the revert button shows.
export const Revertible: Story = {
  beforeEach: seedPresets({
    ...EMPTY,
    activePresetId: BUILT_IN_PRESETS[0]!.id,
    preActivationSnapshot: {
      strategy: "balanced",
      mappings: [],
      routingConfig: makeRoutingConfig(),
      timestamp: Date.UTC(2026, 5, 20, 9, 0, 0),
    },
  }),
}
