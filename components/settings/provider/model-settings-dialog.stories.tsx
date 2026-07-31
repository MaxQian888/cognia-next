import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { makeModelConfig } from "@/lib/storybook/fixtures/settings-provider"
import { ModelSettingsDialog } from "./model-settings-dialog"

// Per-model settings dialog: capability toggles, context window, max-output
// slider, and pricing. Settings derive from the passed `model`. The "Fetch"
// pricing button simulates an async call on click only. When `model` is null
// the component renders nothing.

const meta = {
  title: "Settings/Provider/ModelSettingsDialog",
  component: ModelSettingsDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onSave: fn(),
    providerId: "openai",
    model: makeModelConfig({ id: "gpt-4.1", name: "GPT-4.1" }),
  },
} satisfies Meta<typeof ModelSettingsDialog>

export default meta
type Story = StoryObj<typeof meta>

// Open with a vision+tools chat model pre-filled.
export const Open: Story = {}

// A reasoning model with no vision capability and higher pricing.
export const ReasoningModel: Story = {
  args: {
    model: makeModelConfig({
      id: "o3",
      name: "o3",
      supportsVision: false,
      supportsReasoning: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      pricing: { promptPer1M: 10, completionPer1M: 40 },
    }),
  },
}

// No model selected — the dialog renders nothing.
export const NoModel: Story = {
  args: {
    model: null,
  },
}
