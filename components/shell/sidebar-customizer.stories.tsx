import type { Meta, StoryObj } from "@storybook/nextjs"

import { SidebarCustomizer } from "./sidebar-customizer"

// Propless wrapper that wires the shared `CustomizerLists` to `useSidebarLayout`
// (settings store). With default settings it renders the factory sidebar layout
// across the Pinned / More / Hidden buckets.
const meta = {
  title: "Shell/SidebarCustomizer",
  component: SidebarCustomizer,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidebarCustomizer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
