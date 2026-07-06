import type { Meta, StoryObj } from "@storybook/nextjs"

import { ReliabilitySection } from "./reliability-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeRoutingConfig } from "@/lib/storybook/fixtures/settings-provider"
import type { RoutingCircuitBreakerSettings } from "@cognia/provider-types/model-mapping"
import type { AppSettings } from "@/lib/claude/types"

// Circuit-breaker reliability settings (global enable, absolute vs failure-rate
// trip mode, cooldown clamps) + a read-only view of the active pre-call filter
// chain. Reads + writes `settings.routingConfig.circuitBreaker`.
const seedBreaker = (circuitBreaker: RoutingCircuitBreakerSettings) => () => {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, {
    settings: { routingConfig: makeRoutingConfig({ circuitBreaker }) } as AppSettings,
  })
}

const meta = {
  title: "Settings/Provider/Routing/ReliabilitySection",
  component: ReliabilitySection,
  parameters: { layout: "padded" },
  beforeEach: seedBreaker({ enabled: false }),
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ReliabilitySection>

export default meta
type Story = StoryObj<typeof meta>

// Breaker disabled — only the master switch and the filter chain are visible.
export const Disabled: Story = {}

// Absolute-count trip mode: consecutive-failure threshold + cooldown clamps.
export const AbsoluteMode: Story = {
  beforeEach: seedBreaker({
    enabled: true,
    failureThreshold: 5,
    cooldownMs: 30_000,
    maxCooldownMs: 300_000,
  }),
}

// Failure-rate trip mode: percentage threshold + minimum request volume.
export const FailureRateMode: Story = {
  beforeEach: seedBreaker({
    enabled: true,
    failureThreshold: 5,
    cooldownMs: 30_000,
    failureRateThreshold: 0.5,
    minRequestVolume: 20,
    maxCooldownMs: 300_000,
  }),
}
