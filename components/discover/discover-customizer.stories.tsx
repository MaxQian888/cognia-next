import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiscoverCustomizer } from "./discover-customizer"

// Three-bucket category editor (Pinned / More / Hidden) wired to
// `useDiscoverLayout`. Renders the default layout when nothing is persisted.
const meta = {
  title: "Discover/DiscoverCustomizer",
  component: DiscoverCustomizer,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverCustomizer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
