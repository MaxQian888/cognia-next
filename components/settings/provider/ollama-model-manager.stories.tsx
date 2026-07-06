import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OllamaModelManager } from "./ollama-model-manager"

// Ollama-specific model manager. Backed by the `useOllama` hook, which lists
// models via Ollama's REST API. In Storybook the endpoint is unreachable, so
// the hook reports DISCONNECTED and the component renders its "Ollama not
// running" empty branch (the no-backend path). Pull / delete / stop only fire
// on user interaction. `OllamaModelManager` is a named (non-default) export.

const meta = {
  title: "Settings/Provider/OllamaModelManager",
  component: OllamaModelManager,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    baseUrl: "http://localhost:11434",
    onModelSelect: fn(),
  },
} satisfies Meta<typeof OllamaModelManager>

export default meta
type Story = StoryObj<typeof meta>

// Full card; no Ollama server reachable → start-hint empty state.
export const Disconnected: Story = {}

// Compact variant — status line only (chips appear when connected).
export const Compact: Story = {
  args: {
    compact: true,
  },
}
