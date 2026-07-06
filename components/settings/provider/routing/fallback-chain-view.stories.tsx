import type { Meta, StoryObj } from "@storybook/nextjs"

import { FallbackChainView } from "./fallback-chain-view"
import { makeModelMappingEntry } from "@/lib/storybook/fixtures/settings-provider"

// Pure presentational component: renders a `provider:model` fallback chain as a
// row of badges joined by arrows, highlighting `selectedIndex` (default 0).
// Props-only — no store, no Dexie. Returns null when `entries` is empty.
const meta = {
  title: "Settings/Provider/Routing/FallbackChainView",
  component: FallbackChainView,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FallbackChainView>

export default meta
type Story = StoryObj<typeof meta>

// A single primary entry — no arrows, the lone badge is the selection.
export const SingleEntry: Story = {
  args: {
    entries: [makeModelMappingEntry({ providerId: "anthropic", modelId: "claude-sonnet-4-6" })],
  },
}

// A multi-hop chain: primary → fallback → fallback, first highlighted.
export const MultiEntry: Story = {
  args: {
    entries: [
      makeModelMappingEntry({ providerId: "anthropic", modelId: "claude-sonnet-4-6", weight: 70 }),
      makeModelMappingEntry({ providerId: "openai", modelId: "gpt-4.1", weight: 20 }),
      makeModelMappingEntry({ providerId: "deepseek", modelId: "deepseek-v4-flash", weight: 10 }),
    ],
  },
}

// A later entry highlighted as the active selection (e.g. primary tripped).
export const SelectedFallback: Story = {
  args: {
    entries: MultiEntry.args!.entries!,
    selectedIndex: 1,
  },
}

// Entries without weights render the bare `provider:model` label (no ×N suffix).
export const WithoutWeights: Story = {
  args: {
    entries: [
      makeModelMappingEntry({
        providerId: "anthropic",
        modelId: "claude-opus-4-8",
        weight: undefined,
      }),
      makeModelMappingEntry({ providerId: "openai", modelId: "o3", weight: undefined }),
    ],
  },
}
