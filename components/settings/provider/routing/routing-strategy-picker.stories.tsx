import type { Meta, StoryObj } from "@storybook/nextjs"

import { RoutingStrategyPicker } from "./routing-strategy-picker"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeRoutingConfig } from "@/lib/storybook/fixtures/settings-provider"
import type { RoutingStrategy } from "@cognia/provider-types/auto-router"
import type { AppSettings } from "@/lib/claude/types"

// Global routing strategy picker plus the request-timeout / max-fallback-attempts
// numbers. Reads + writes `settings.routingConfig` on `useSettingsStore`.
const seedStrategy = (strategy: RoutingStrategy) => () => {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, {
    settings: { routingConfig: makeRoutingConfig({ strategy }) } as AppSettings,
  })
}

const meta = {
  title: "Settings/Provider/Routing/RoutingStrategyPicker",
  component: RoutingStrategyPicker,
  parameters: { layout: "padded" },
  beforeEach: seedStrategy("balanced"),
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RoutingStrategyPicker>

export default meta
type Story = StoryObj<typeof meta>

// Default "balanced" strategy with the shipped timeout/fallback numbers.
export const Balanced: Story = {}

// Quality-first strategy selected.
export const Quality: Story = {
  beforeEach: seedStrategy("quality"),
}

// The heuristic "difficulty" strategy selected.
export const Difficulty: Story = {
  beforeEach: seedStrategy("difficulty"),
}

// Cost-optimized strategy selected.
export const Cost: Story = {
  beforeEach: seedStrategy("cost"),
}
