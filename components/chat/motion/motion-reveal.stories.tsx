import type { Meta, StoryObj } from "@storybook/nextjs"

import { MotionReveal } from "./motion-reveal"

// One-shot entrance (fade + small translateY) for newly-streamed agent-flow
// cards/rows. Reduced-motion collapses it to a plain wrapper.
const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-md border bg-card px-3 py-2 text-sm shadow-sm">{children}</div>
)

const meta = {
  title: "Chat/Motion/MotionReveal",
  component: MotionReveal,
  parameters: { layout: "padded" },
  args: {
    index: 0,
    children: <Card>A tool call card sliding in.</Card>,
  },
} satisfies Meta<typeof MotionReveal>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

/** A staggered list — later items reveal slightly after earlier ones. */
export const StaggeredList: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {["Read app/page.tsx", "Grep for usePlatform", "Edit lib/utils.ts"].map((label, i) => (
        <MotionReveal key={label} index={i}>
          <Card>{label}</Card>
        </MotionReveal>
      ))}
    </div>
  ),
}

/** Force-disabled — renders a plain wrapper with no animation. */
export const Disabled: Story = {
  args: { disabled: true, children: <Card>No entrance animation.</Card> },
}
