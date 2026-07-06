import type { Meta, StoryObj } from "@storybook/nextjs"
import { AnthropicSubscriptionReuseCard } from "./anthropic-subscription-reuse-card"

// Tauri-branching + Dexie component. In Storybook `isTauri()` is false, so the
// desktop-only subscription/CCSwitch alerts are hidden and only the
// cross-platform privacy note renders (plus an empty `settings.ai` plugin
// slot). The Anthropic credential hook resolves to `null` against the empty
// browser DB. This Default captures that web fallback.
const meta = {
  title: "Settings/Provider/AnthropicSubscriptionReuseCard",
  component: AnthropicSubscriptionReuseCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AnthropicSubscriptionReuseCard>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
