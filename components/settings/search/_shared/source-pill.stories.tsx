import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SourcePill } from "./source-pill"

// `SourcePill` is a pure props-only toggle chip used in the search "research
// sources" picker. It renders a selected/unselected pill, an optional remove
// affordance for custom sources, and a disabled state.
const meta = {
  title: "Settings/Search/Shared/SourcePill",
  component: SourcePill,
  parameters: { layout: "centered" },
  args: {
    sourceId: "wikipedia",
    name: "Wikipedia",
    icon: "📚",
    selected: false,
    disabled: false,
    onToggle: fn(),
  },
} satisfies Meta<typeof SourcePill>

export default meta
type Story = StoryObj<typeof meta>

export const Unselected: Story = {}

export const Selected: Story = {
  args: { selected: true },
}

export const Disabled: Story = {
  args: { disabled: true },
}

// Custom sources expose a remove (×) affordance via `onRemove`.
export const Removable: Story = {
  args: {
    sourceId: "custom-1",
    name: "Internal Wiki",
    icon: "🔒",
    selected: true,
    onRemove: fn(),
  },
}

// Falls back to the 🔗 glyph when no icon is provided.
export const DefaultIcon: Story = {
  args: { icon: undefined, name: "Custom Source" },
}
