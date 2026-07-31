import type { Meta, StoryObj } from "@storybook/nextjs"

import { ProviderAdvancedTab } from "./provider-advanced-tab"

// Legacy compound tab, now a lightweight placeholder pointing at the split
// Routing / Health / Presets tabs. Pure, no props, no store.
const meta = {
  title: "Settings/Provider/ProviderAdvancedTab",
  component: ProviderAdvancedTab,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderAdvancedTab>

export default meta
type Story = StoryObj<typeof meta>

// The three placeholder sections (routing / health / presets).
export const Default: Story = {}
