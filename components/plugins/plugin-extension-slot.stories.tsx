import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginExtensionSlot } from "./plugin-extension-slot"

// Renders whatever extensions plugins have registered for a canonical extension
// point, ordered by priority. In Storybook the extension registry is empty, so
// the slot renders its `fallback` (or nothing). This is the host primitive the
// toolbar/sidebar/chat surfaces mount.

const meta = {
  title: "Plugins/PluginExtensionSlot",
  component: PluginExtensionSlot,
  args: { point: "toolbar.right" },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginExtensionSlot>

export default meta
type Story = StoryObj<typeof meta>

// Empty registry with a fallback node → the fallback shows.
export const WithFallback: Story = {
  args: {
    fallback: (
      <span className="text-xs text-muted-foreground">No toolbar extensions installed</span>
    ),
  },
}

// Empty registry, no fallback → renders nothing.
export const EmptyNoFallback: Story = {}
