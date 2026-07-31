import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PerformanceTierFields } from "./performance-tier-popover"
import type {
  PerformanceTier,
  ResolvedPerformanceTier,
} from "@/lib/workflow/editor/performance-tier"

// Controlled wrapper so the radio selection is interactive in the story.
function Demo({
  initial = "auto",
  effective = "balanced",
}: {
  initial?: PerformanceTier
  effective?: ResolvedPerformanceTier
}) {
  const [tier, setTier] = React.useState<PerformanceTier>(initial)
  return (
    <div className="w-72">
      <PerformanceTierFields value={tier} effective={effective} onChange={setTier} />
    </div>
  )
}

const meta = {
  title: "Workflow/PerformanceTierFields",
  component: PerformanceTierFields,
  parameters: { layout: "centered" },
  // Default args satisfy the required props; the stories override `render`.
  args: { value: "auto", effective: "balanced", onChange: fn() },
} satisfies Meta<typeof PerformanceTierFields>

export default meta
type Story = StoryObj<typeof meta>

// "Auto" selected, resolving to the balanced tier on this graph.
export const AutoBalanced: Story = {
  render: () => <Demo initial="auto" effective="balanced" />,
}

// User forced the high-detail tier.
export const HighTier: Story = {
  render: () => <Demo initial="high" effective="high" />,
}

// "Auto" downshifted to reduced on a large / low-power graph.
export const ReducedForLargeGraph: Story = {
  render: () => <Demo initial="auto" effective="reduced" />,
}
