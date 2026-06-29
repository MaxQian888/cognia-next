import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactElement } from "react"

import { DragOverlay } from "./drag-overlay"

// The overlay is absolutely positioned over the composer; anchor it in a
// relative, sized box that stands in for the composer surface.
function inComposerBox(Story: () => ReactElement) {
  return (
    <div className="relative h-32 w-96 rounded-xl border bg-background">
      <div className="p-3 text-sm text-muted-foreground">Composer surface…</div>
      <Story />
    </div>
  )
}

const meta = {
  title: "Chat/Composer/DragOverlay",
  component: DragOverlay,
  parameters: { layout: "padded" },
  decorators: [inComposerBox],
} satisfies Meta<typeof DragOverlay>

export default meta
type Story = StoryObj<typeof meta>

// Visible — dashed border + "drop to attach" prompt.
export const Visible: Story = {
  args: { visible: true },
}

// Custom label.
export const CustomLabel: Story = {
  args: { visible: true, label: "Release to attach 3 files" },
}

// Hidden (opacity 0) — the resting state.
export const Hidden: Story = {
  args: { visible: false },
}
