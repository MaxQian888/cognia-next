import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LocalProviderModelManager } from "./local-provider-model-manager"

// Unified local-provider model manager (Ollama / LocalAI / Jan). It drives the
// `useLocalProvider` hook, which probes the server over HTTP. In Storybook no
// local server is running, so the hook settles into the DISCONNECTED state and
// the component renders its "not running / install" empty branch — the web /
// no-backend path. Pull, delete, and stop only fire on user interaction.

const meta = {
  title: "Settings/Provider/LocalProviderModelManager",
  component: LocalProviderModelManager,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    providerId: "ollama",
    onModelSelect: fn(),
  },
} satisfies Meta<typeof LocalProviderModelManager>

export default meta
type Story = StoryObj<typeof meta>

// Full card; no server reachable → "Ollama not running" install prompt.
export const Disconnected: Story = {}

// Compact variant — just the status line (and chips when connected).
export const Compact: Story = {
  args: {
    compact: true,
  },
}
