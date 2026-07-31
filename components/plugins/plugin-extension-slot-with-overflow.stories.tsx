import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginExtensionSlotWithOverflow } from "./plugin-extension-slot-with-overflow"

// Variant of the extension slot that renders up to `limit` extensions inline and
// pushes the rest into an overflow popover. With an empty registry (Storybook),
// it renders the `fallback`.

const meta = {
  title: "Plugins/PluginExtensionSlotWithOverflow",
  component: PluginExtensionSlotWithOverflow,
  args: { point: "toolbar.right", limit: 3, overflowLabel: "More toolbar actions" },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginExtensionSlotWithOverflow>

export default meta
type Story = StoryObj<typeof meta>

export const WithFallback: Story = {
  args: {
    fallback: (
      <span className="text-xs text-muted-foreground">No toolbar extensions installed</span>
    ),
  },
}
