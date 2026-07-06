import type { Meta, StoryObj } from "@storybook/nextjs"

import { RoutingConfigPanel } from "./routing-config-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeModelMapping,
  makeProviderConstraint,
  makeProviderSettingsMap,
  makeRoutingConfig,
} from "@/lib/storybook/fixtures/settings-provider"
import {
  DEFAULT_DIFFICULTY_ROUTING,
  DEFAULT_SEMANTIC_TOOL_ROUTING,
} from "@/types/routing/tool-route"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Orchestrator for the whole routing tab: global-scope banner + presets +
// strategy + alias mappings + constraints + reliability + semantic/difficulty
// sections + live test panel. Every section reads `useSettingsStore`, so the
// stories seed a full routing slice.
const meta = {
  title: "Settings/Provider/Routing/RoutingConfigPanel",
  component: RoutingConfigPanel,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({
        providerSettings: makeProviderSettingsMap(),
        modelMappings: [],
        routingConfig: makeRoutingConfig(),
        routingPresets: { customPresets: [], activePresetId: null, preActivationSnapshot: null },
        difficultyRouting: DEFAULT_DIFFICULTY_ROUTING,
        semanticToolRouting: DEFAULT_SEMANTIC_TOOL_ROUTING,
      }),
    })
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RoutingConfigPanel>

export default meta
type Story = StoryObj<typeof meta>

// Fresh routing config — defaults everywhere, no aliases or constraints yet.
export const Default: Story = {}

// A fully-populated routing config: aliases, constraints, an active strategy.
export const Populated: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({
        providerSettings: makeProviderSettingsMap(),
        modelMappings: [
          makeModelMapping({ alias: "fast", distribution: "priority" }),
          makeModelMapping({ alias: "balanced", distribution: "weighted" }),
        ],
        routingConfig: makeRoutingConfig({
          strategy: "cost",
          providerConstraints: [
            makeProviderConstraint({ providerId: "openai", dailyCostBudget: 25 }),
          ],
          circuitBreaker: { enabled: true, failureThreshold: 5, cooldownMs: 30_000 },
        }),
        routingPresets: { customPresets: [], activePresetId: null, preActivationSnapshot: null },
        difficultyRouting: { ...DEFAULT_DIFFICULTY_ROUTING, enabled: true },
        semanticToolRouting: { ...DEFAULT_SEMANTIC_TOOL_ROUTING, enabled: true },
      }),
    })
  },
}
