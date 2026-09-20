import type { Meta, StoryObj } from "@storybook/nextjs"

import { SearchProviderHealthPanel } from "./search-provider-health-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeConfiguredProviders,
  makeSearchAppSettings,
} from "@/lib/storybook/fixtures/settings-search"
import {
  getProviderHealth,
  resetProviderHealth,
} from "@cognia/web-search/provider-health"

// `SearchProviderHealthPanel` reads the in-memory ProviderHealth singleton —
// stories seed it with recorded results so healthy/degraded/open rows show —
// and the store for which providers are enabled+configured.
const meta = {
  title: "Settings/Search/SearchProviderHealthPanel",
  component: SearchProviderHealthPanel,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetProviderHealth()
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({ searchProviders: makeConfiguredProviders() }),
    })
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchProviderHealthPanel>

export default meta
type Story = StoryObj<typeof meta>

// No traffic yet → configured providers render as "unknown".
export const NoTraffic: Story = {}

export const MixedHealth: Story = {
  beforeEach: () => {
    const health = getProviderHealth()
    health.recordResult("tavily", true, 320)
    health.recordResult("tavily", true, 410)
    health.recordResult("tavily", true, 380)
    health.recordResult("brave", true, 900)
    health.recordResult("brave", false)
    health.recordResult("brave", false)
  },
}

export const TrippedBreaker: Story = {
  beforeEach: () => {
    const health = getProviderHealth()
    for (let i = 0; i < 3; i++) health.recordResult("tavily", false)
    health.recordResult("brave", true, 500)
  },
}

export const BreakerDisabled: Story = {
  beforeEach: () => {
    resetProviderHealth()
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchProviders: makeConfiguredProviders(),
        searchProviderHealth: { enabled: false, failureThreshold: 3, cooldownMs: 30_000 },
      }),
    })
  },
}

export const Empty: Story = {
  beforeEach: () => {
    resetProviderHealth()
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeSearchAppSettings() })
  },
}
