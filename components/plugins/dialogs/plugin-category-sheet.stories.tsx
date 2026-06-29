import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginCategorySheet } from "./plugin-category-sheet"

// Mobile/tablet drawer trigger that wraps `PluginCategorySidebar` in a Sheet for
// viewports below `lg`. The sheet open state is internal, so the story renders
// the trigger button in its default (closed) state; opening it reveals the
// category sidebar.

const meta = {
  title: "Plugins/Dialogs/PluginCategorySheet",
  component: PluginCategorySheet,
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginCategorySheet>

export default meta
type Story = StoryObj<typeof meta>

export const Trigger: Story = {}
