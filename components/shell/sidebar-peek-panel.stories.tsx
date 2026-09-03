import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"

import { SidebarPeekEdge, SidebarPeekFrame } from "./sidebar-peek-panel"

/**
 * The collapsed rail's edge peek, staged the way the shell mounts it: both
 * pieces are children of a zero-width `relative` box standing in for the
 * collapsed `<aside>`, with a slab of "conversation" behind them so the
 * clipping and the elevation are actually visible.
 */
function Conversation() {
  return (
    <div className="flex-1 p-4 text-sm text-muted-foreground">
      Conversation. Hover the seam to float the rail back over it.
    </div>
  )
}

function Stage({ side }: { side: "left" | "right" }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative flex h-[420px] w-full overflow-hidden rounded-panel border bg-muted/30">
      {side === "left" ? <div className="w-14 shrink-0 border-r bg-muted/60" /> : null}
      {/* The conversation leads on the right-docked edge, the way the shell
          orders the row: the rail is always the outermost column. */}
      {side === "right" ? <Conversation /> : null}
      <div className="relative w-0 shrink-0">
        <SidebarPeekEdge
          side={side}
          active={open}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        />
        <SidebarPeekFrame
          armed
          open={open}
          side={side}
          width={260}
          onPin={() => setOpen(false)}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <div className="flex h-full flex-col gap-1 bg-background/70 p-2 text-[13px]">
            <div className="h-8 rounded-control bg-muted/60" />
            {["Quarterly planning", "Release notes", "Bug triage", "Design review"].map((title) => (
              <div key={title} className="rounded-control px-2 py-1.5 hover:bg-accent">
                {title}
              </div>
            ))}
          </div>
        </SidebarPeekFrame>
      </div>
      {side === "left" ? <Conversation /> : null}
      {side === "right" ? <div className="w-14 shrink-0 border-l bg-muted/60" /> : null}
    </div>
  )
}

const meta = {
  title: "Shell/SidebarPeekPanel",
  parameters: { layout: "padded" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const LeftEdge: Story = { render: () => <Stage side="left" /> }
export const RightEdge: Story = { render: () => <Stage side="right" /> }
