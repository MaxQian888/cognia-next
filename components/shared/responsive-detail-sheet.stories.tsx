import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ResponsiveDetailSheet } from "./responsive-detail-sheet"
import { Badge } from "@/components/ui/badge"

// Shared detail surface: a right Sheet on desktop, a bottom Drawer on mobile.
// Renders its children identically in both shells.
const meta = {
  title: "Shared/ResponsiveDetailSheet",
  component: ResponsiveDetailSheet,
  args: {
    open: true,
    onOpenChange: fn(),
    title: "Triage the open bug backlog",
    description: "An autonomous goal working through the top issues.",
    children: (
      <div className="px-4 py-6 text-sm text-muted-foreground">Detail body content goes here.</div>
    ),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ResponsiveDetailSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const WithHeaderExtra: Story = {
  args: {
    headerExtra: (
      <div className="flex gap-2 pt-2">
        <Badge variant="secondary">active</Badge>
        <Badge variant="outline">7 / 20 turns</Badge>
      </div>
    ),
  },
}

export const Closed: Story = {
  args: { open: false },
}
