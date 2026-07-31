import type { Meta, StoryObj } from "@storybook/nextjs"

import { SemanticRoutingSection } from "./semantic-routing-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  DEFAULT_SEMANTIC_TOOL_ROUTING,
  type SemanticToolRoutingSettings,
} from "@/types/routing/tool-route"
import type { AppSettings } from "@cognia/agent-config-types"

// Opt-in semantic tool routing: prune the exposed plugin-tool manifest to the
// top-K semantic matches plus pinned tools. Reads + writes
// `settings.semanticToolRouting`. Numeric fields disable until enabled.
const seedSemantic = (semanticToolRouting: SemanticToolRoutingSettings) => () => {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, { settings: { semanticToolRouting } as AppSettings })
}

const meta = {
  title: "Settings/Provider/Routing/SemanticRoutingSection",
  component: SemanticRoutingSection,
  parameters: { layout: "padded" },
  beforeEach: seedSemantic(DEFAULT_SEMANTIC_TOOL_ROUTING),
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SemanticRoutingSection>

export default meta
type Story = StoryObj<typeof meta>

// Default OFF — activation count / top-K / threshold inputs are disabled.
export const Disabled: Story = {}

// Enabled with custom thresholds and a list of pinned tools.
export const Enabled: Story = {
  beforeEach: seedSemantic({
    enabled: true,
    activationToolCount: 16,
    topK: 8,
    threshold: 0.4,
    pinnedTools: ["web_search", "read_file", "bash"],
  }),
}
