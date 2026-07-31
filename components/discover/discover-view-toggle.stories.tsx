import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiscoverViewToggle } from "./discover-view-toggle"

// Grid / list / compact toggle bound to `useDiscoverView` (persists per-category
// to AppSettings). With no setting persisted it falls back to the default mode.
const meta = {
  title: "Discover/DiscoverViewToggle",
  component: DiscoverViewToggle,
  args: { category: "characters" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof DiscoverViewToggle>

export default meta
type Story = StoryObj<typeof meta>

export const Characters: Story = {}

export const Skills: Story = { args: { category: "skills" } }
