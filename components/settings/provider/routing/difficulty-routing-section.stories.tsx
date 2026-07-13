import type { Meta, StoryObj } from "@storybook/nextjs"

import { DifficultyRoutingSection } from "./difficulty-routing-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  DEFAULT_DIFFICULTY_ROUTING,
  type DifficultyRoutingSettings,
} from "@/types/routing/tool-route"
import type { AppSettings } from "@cognia/agent-config-types"

// Opt-in heuristic strong/weak difficulty routing. Reads + writes
// `settings.difficultyRouting`. Inputs are disabled until the master switch is
// on. Default OFF.
const seedDifficulty = (difficultyRouting: DifficultyRoutingSettings) => () => {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, { settings: { difficultyRouting } as AppSettings })
}

const meta = {
  title: "Settings/Provider/Routing/DifficultyRoutingSection",
  component: DifficultyRoutingSection,
  parameters: { layout: "padded" },
  beforeEach: seedDifficulty(DEFAULT_DIFFICULTY_ROUTING),
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DifficultyRoutingSection>

export default meta
type Story = StoryObj<typeof meta>

// Default OFF — model-pair and threshold fields are disabled.
export const Disabled: Story = {}

// Enabled with a configured weak/strong model pair and a custom threshold.
export const Enabled: Story = {
  beforeEach: seedDifficulty({
    enabled: true,
    weakModel: { providerId: "openai", modelId: "gpt-4.1-mini" },
    strongModel: { providerId: "anthropic", modelId: "claude-opus-4-8" },
    threshold: 0.6,
  }),
}

// Enabled but unconfigured — switch is on, model pairs still empty.
export const EnabledUnconfigured: Story = {
  beforeEach: seedDifficulty({ ...DEFAULT_DIFFICULTY_ROUTING, enabled: true }),
}
