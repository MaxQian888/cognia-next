import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MobileNodePaletteSheet } from "./mobile-node-palette-sheet"

// Bottom-sheet node palette (opened by the editor FAB). Embeds the desktop
// `NodeSearchSidebar` in tap-to-add mode; the catalog is in-memory, so it
// renders without app providers. Open by default to show the sheet content.
const meta = {
  title: "Mobile/Workflow/Editor/MobileNodePaletteSheet",
  component: MobileNodePaletteSheet,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn(), onAdd: fn() },
} satisfies Meta<typeof MobileNodePaletteSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
