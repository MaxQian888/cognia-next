import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ModelAliasEntryRow } from "./model-alias-entry-row"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeModelMappingEntry,
  makeProviderSettingsMap,
} from "@/lib/storybook/fixtures/settings-provider"
import type { AppSettings } from "@/lib/claude/types"

// One provider:model entry inside the alias editor — picker + optional weight +
// per-entry condition popover + reorder/remove controls. Driven by props; the
// embedded `ProviderModelCombobox` reads provider options from the settings
// store, so we seed it for realistic picker contents.
const seedProviders = () => {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, {
    settings: { providerSettings: makeProviderSettingsMap() } as AppSettings,
  })
}

const meta = {
  title: "Settings/Provider/Routing/ModelAliasEntryRow",
  component: ModelAliasEntryRow,
  parameters: { layout: "padded" },
  beforeEach: seedProviders,
  args: {
    onChange: fn(),
    onMove: fn(),
    onRemove: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ModelAliasEntryRow>

export default meta
type Story = StoryObj<typeof meta>

// Priority distribution — no weight input; first of three rows (move-up off).
export const FirstRow: Story = {
  args: {
    entry: makeModelMappingEntry({ providerId: "anthropic", modelId: "claude-sonnet-4-6" }),
    index: 0,
    total: 3,
    showWeight: false,
  },
}

// A middle row — both reorder controls enabled.
export const MiddleRow: Story = {
  args: {
    entry: makeModelMappingEntry({ providerId: "openai", modelId: "gpt-4.1" }),
    index: 1,
    total: 3,
    showWeight: false,
  },
}

// Last row — move-down disabled.
export const LastRow: Story = {
  args: {
    entry: makeModelMappingEntry({ providerId: "deepseek", modelId: "deepseek-v4-flash" }),
    index: 2,
    total: 3,
    showWeight: false,
  },
}

// Weighted distribution exposes the numeric weight input.
export const Weighted: Story = {
  args: {
    entry: makeModelMappingEntry({ providerId: "openai", modelId: "gpt-4.1", weight: 30 }),
    index: 0,
    total: 2,
    showWeight: true,
  },
}

// An entry carrying price/latency conditions — the gear renders as "active".
export const WithConditions: Story = {
  args: {
    entry: makeModelMappingEntry({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      conditions: { maxCostPer1M: 5, maxLatencyMs: 2000 },
    }),
    index: 0,
    total: 1,
    showWeight: false,
  },
}
