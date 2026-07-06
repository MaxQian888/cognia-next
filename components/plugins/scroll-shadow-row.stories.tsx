import type { Meta, StoryObj } from "@storybook/nextjs"

import { ScrollShadowRow } from "./scroll-shadow-row"
import { Badge } from "@/components/ui/badge"

// Horizontally-scrollable strip with edge-fade affordances. Wraps any
// inline-flex row (devtools sub-tabs, marketplace section toggles) and paints
// gradient fades on whichever edge currently overflows, via a ResizeObserver.
// The fades only appear once the inner scroller actually overflows.

const meta = {
  title: "Plugins/ScrollShadowRow",
  component: ScrollShadowRow,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px] max-w-full rounded-md border p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScrollShadowRow>

export default meta
type Story = StoryObj<typeof meta>

const Chips = ({ count }: { count: number }) => (
  <div className="flex w-max gap-2">
    {Array.from({ length: count }, (_, i) => (
      <Badge key={i} variant="outline" className="whitespace-nowrap">
        Category {i + 1}
      </Badge>
    ))}
  </div>
)

// Many chips → the row overflows and the right-edge fade appears.
export const Overflowing: Story = {
  args: { children: <Chips count={12} /> },
}

// Few chips that fit within the container → no fades render.
export const FitsWithoutOverflow: Story = {
  args: { children: <Chips count={2} /> },
}
