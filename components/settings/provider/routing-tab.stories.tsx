import type { Meta, StoryObj } from "@storybook/nextjs"

import { RoutingTab } from "./routing-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeRoutingConfig,
  makeModelMapping,
  makeProviderSettingsMap,
} from "@/lib/storybook/fixtures/settings-provider"
import type { AppSettings } from "@/lib/claude/types"

// Thin wrapper around RoutingConfigPanel — the GLOBAL routing surface (strategy,
// presets, alias mappings, constraints, reliability, semantic/difficulty
// routing, live test). Reads NESTED `settings.routingConfig` + `settings.
// modelMappings`; alias picker options come from FLAT `providerSettings`. The
// `providerId` / `providerName` props are accepted but unused.
const meta = {
  title: "Settings/Provider/RoutingTab",
  component: RoutingTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: { routingConfig: makeRoutingConfig() } as AppSettings,
      providerSettings: makeProviderSettingsMap(),
    })
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RoutingTab>

export default meta
type Story = StoryObj<typeof meta>

// Default routing config, no alias mappings yet.
export const Default: Story = {}

// A couple of configured alias → fallback-chain mappings in the alias list.
export const WithAliasMappings: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: {
        routingConfig: makeRoutingConfig(),
        modelMappings: [
          makeModelMapping({ alias: "balanced", distribution: "weighted" }),
          makeModelMapping({ alias: "cheap", distribution: "priority" }),
        ],
      } as AppSettings,
      providerSettings: makeProviderSettingsMap(),
    })
  },
}
