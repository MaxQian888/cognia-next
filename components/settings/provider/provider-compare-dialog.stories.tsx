import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ProviderCompareDialog } from "./provider-compare-dialog"

// Side-by-side provider comparison dialog. `availableProviders` seeds the
// selectable chip row; comparison rows (model count, context, protocol,
// capabilities) are derived from the built-in PROVIDERS catalog when the user
// ticks a provider. Selection is internal, so the table starts empty until a
// chip is checked. Pure props.

const meta = {
  title: "Settings/Provider/ProviderCompareDialog",
  component: ProviderCompareDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    availableProviders: [
      { id: "openai", name: "OpenAI" },
      { id: "anthropic", name: "Anthropic" },
      { id: "google", name: "Google" },
      { id: "deepseek", name: "DeepSeek" },
      { id: "mistral", name: "Mistral" },
    ],
  },
} satisfies Meta<typeof ProviderCompareDialog>

export default meta
type Story = StoryObj<typeof meta>

// Open with selectable providers; comparison table empty until a chip is ticked.
export const Open: Story = {}

// Closed — nothing renders into the portal.
export const Closed: Story = {
  args: {
    open: false,
  },
}
