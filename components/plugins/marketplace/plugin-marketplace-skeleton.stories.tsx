import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginMarketplaceSkeleton } from "./plugin-marketplace-skeleton"

// Loading placeholder for the marketplace card grid. Mirrors the
// 1-/2-/3-column container-query layout of the real grid so nothing shifts
// when entries arrive. The grid keys off `@container/plugin-grid`, so the
// decorator gives it a fixed width that crosses the `@4xl` breakpoint for the
// three-column layout.

const meta = {
  title: "Plugins/Marketplace/PluginMarketplaceSkeleton",
  component: PluginMarketplaceSkeleton,
  args: { count: 6 },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[960px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginMarketplaceSkeleton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Few: Story = { args: { count: 3 } }

// Narrow container collapses the grid to a single column.
export const SingleColumn: Story = {
  args: { count: 3 },
  decorators: [
    (Story) => (
      <div className="w-[320px] max-w-full">
        <Story />
      </div>
    ),
  ],
}
