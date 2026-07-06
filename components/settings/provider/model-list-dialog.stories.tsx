import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeModelConfig } from "@/lib/storybook/fixtures/settings-provider"
import { ModelListDialog } from "./model-list-dialog"

// Searchable / filterable model picker dialog. Each row's pricing is formatted
// against the user's locale currency, which the nested `ModelListItem` reads
// from the settings store (`language`) — so we seed `language: "en"` before each
// render. Models, selection, and the default model come in as props.

const MODELS = [
  makeModelConfig({ id: "gpt-4.1", name: "GPT-4.1" }),
  makeModelConfig({
    id: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    pricing: { promptPer1M: 0.4, completionPer1M: 1.6 },
  }),
  makeModelConfig({
    id: "o3",
    name: "o3",
    supportsVision: false,
    supportsReasoning: true,
    pricing: { promptPer1M: 10, completionPer1M: 40 },
  }),
  makeModelConfig({
    id: "text-embedding-3",
    name: "Text Embedding 3",
    supportsTools: false,
    supportsVision: false,
    pricing: { promptPer1M: 0, completionPer1M: 0 },
  }),
]

const meta = {
  title: "Settings/Provider/ModelListDialog",
  component: ModelListDialog,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, language: "en" })
  },
  args: {
    open: true,
    onOpenChange: fn(),
    onModelsChange: fn(),
    onDefaultModelChange: fn(),
    onModelSettings: fn(),
    providerName: "OpenAI",
    models: MODELS,
    selectedModels: ["gpt-4.1", "gpt-4.1-mini"],
    defaultModelId: "gpt-4.1",
  },
} satisfies Meta<typeof ModelListDialog>

export default meta
type Story = StoryObj<typeof meta>

// Populated list with two enabled models, a default star, and per-row settings.
export const Populated: Story = {}

// No models — the empty placeholder is shown.
export const Empty: Story = {
  args: {
    models: [],
    selectedModels: [],
    defaultModelId: undefined,
  },
}

// Closed — nothing renders into the portal.
export const Closed: Story = {
  args: {
    open: false,
  },
}
