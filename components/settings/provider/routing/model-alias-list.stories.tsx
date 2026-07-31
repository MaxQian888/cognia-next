import type { Meta, StoryObj } from "@storybook/nextjs"

import { ModelAliasList } from "./model-alias-list"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeModelMapping,
  makeModelMappingEntry,
  makeProviderSettingsMap,
} from "@/lib/storybook/fixtures/settings-provider"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"
import type { AppSettings } from "@cognia/agent-config-types"

// Model-alias mapping CRUD list. Each row shows the alias, its distribution
// badge, the fallback chain, and edit/delete controls. Reads
// `settings.modelMappings`; the embedded editor reads provider options too.
const seedMappings = (modelMappings: ModelMapping[]) => () => {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, {
    settings: { modelMappings, providerSettings: makeProviderSettingsMap() } as AppSettings,
  })
}

const meta = {
  title: "Settings/Provider/Routing/ModelAliasList",
  component: ModelAliasList,
  parameters: { layout: "padded" },
  beforeEach: seedMappings([]),
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ModelAliasList>

export default meta
type Story = StoryObj<typeof meta>

// No aliases configured — the empty state plus the add button.
export const Empty: Story = {}

// Several aliases, including a weighted one and a disabled one.
export const Populated: Story = {
  beforeEach: seedMappings([
    makeModelMapping({ alias: "fast", distribution: "priority" }),
    makeModelMapping({
      alias: "balanced",
      distribution: "weighted",
      providers: [
        makeModelMappingEntry({
          providerId: "anthropic",
          modelId: "claude-sonnet-4-6",
          weight: 60,
        }),
        makeModelMappingEntry({ providerId: "openai", modelId: "gpt-4.1", weight: 40 }),
      ],
    }),
    makeModelMapping({ alias: "experimental", enabled: false }),
  ]),
}
