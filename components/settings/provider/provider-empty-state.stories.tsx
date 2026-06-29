import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { Button } from "@/components/ui/button"
import { ProviderEmptyState } from "./provider-empty-state"

// Pure component: empty-state card shown when no providers are configured.
// Props drive the two primary actions plus optional guidance rows and an
// alternate import-button slot.
const meta = {
  title: "Settings/Provider/ProviderEmptyState",
  component: ProviderEmptyState,
  parameters: { layout: "padded" },
  args: {
    onAddProvider: fn(),
    onImportSettings: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderEmptyState>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithGuidance: Story = {
  args: {
    guidanceItems: [
      {
        id: "openai",
        label: "Connect OpenAI",
        description: "Paste an API key to enable GPT-4.1 and o3.",
        actionLabel: "Connect",
        onAction: fn(),
      },
      {
        id: "anthropic",
        label: "Connect Anthropic",
        description: "Reuse your Claude Pro/Max subscription.",
        actionLabel: "Connect",
        onAction: fn(),
      },
    ],
  },
}

export const WithCustomImportButton: Story = {
  args: {
    importButton: (
      <Button variant="secondary" onClick={fn()}>
        Restore from backup
      </Button>
    ),
  },
}
