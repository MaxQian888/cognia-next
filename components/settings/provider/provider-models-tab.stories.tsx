import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ProviderModelsTab, type ModelConfig } from "./provider-models-tab"

// Models tab for a provider's detail pane: a compact, sortable table with
// capability glyphs, context / output / price columns, per-model enable
// switches, batch operations, and (when the pane supplies a selection) a
// compare column feeding the cross-provider comparison. Pure props.

const MODELS: ModelConfig[] = [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    family: "gpt-4.1",
    capabilities: ["tools", "vision"],
    contextLength: 1_000_000,
    maxOutputTokens: 32_768,
    releaseDate: "2026-01-15",
    knowledge: "2025-10",
    pricing: { promptPer1M: 2, completionPer1M: 8 },
  },
  {
    id: "o3",
    name: "o3",
    family: "o-series",
    capabilities: ["tools", "reasoning"],
    contextLength: 200_000,
    variants: ["low", "medium", "high"],
    modeCount: 3,
    releaseDate: "2025-12-01",
    pricing: { promptPer1M: 10, completionPer1M: 40 },
  },
  {
    id: "gpt-3.5-turbo",
    name: "GPT-3.5 Turbo",
    family: "gpt-3.5",
    capabilities: ["tools"],
    contextLength: 16_000,
    status: "deprecated",
    releaseDate: "2023-03-01",
  },
  {
    id: "llama-3-70b",
    name: "Llama 3 70B",
    family: "llama",
    capabilities: ["tools"],
    contextLength: 128_000,
    openWeights: true,
    adapter: "@ai-sdk/openai-compatible",
  },
]

const meta = {
  title: "Settings/Provider/ProviderModelsTab",
  component: ProviderModelsTab,
  parameters: { layout: "padded" },
  args: {
    providerId: "openai",
    models: MODELS,
    enabledModels: ["gpt-4.1", "o3"],
    onEnabledModelsChange: fn(),
    onRefreshModels: fn(),
  },
} satisfies Meta<typeof ProviderModelsTab>

export default meta
type Story = StoryObj<typeof meta>

// Populated table with filters, sortable headers, and the batch toolbar.
export const Populated: Story = {}

// Two rows ticked for comparison: the compare column is on and the pinned
// bar at the bottom offers Compare / Clear.
export const Comparing: Story = {
  args: {
    compare: {
      keys: ["openai:gpt-4.1", "openai:o3"],
      onToggle: fn(),
      onOpen: fn(),
      onClear: fn(),
    },
  },
}

// Refresh in progress — spinner on the refresh button.
export const Refreshing: Story = {
  args: {
    isRefreshing: true,
  },
}

// No models — only the search/refresh bar and the empty placeholder.
export const Empty: Story = {
  args: {
    models: [],
    enabledModels: [],
  },
}
