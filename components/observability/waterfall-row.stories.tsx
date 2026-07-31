import type { Meta, StoryObj } from "@storybook/nextjs"

import { WaterfallRow } from "./waterfall-row"
import { makeWaterfallNodes } from "@/lib/storybook/fixtures/observability"

// `WaterfallRow` is one span row in the trace waterfall — an indented label, a
// proportional timing bar, and an expandable mid-span event list. Pure
// props-only. `trace-05` has an errored tool span so the error variants render.
const nodes = makeWaterfallNodes("trace-05")
const rootNode = nodes[0]
const chatNode = nodes.find((n) => n.span.operationName === "chat") ?? rootNode
const errorNode = nodes.find((n) => n.isError) ?? rootNode
const totalMs = Math.max(...nodes.map((n) => n.offsetMs + n.widthMs), 1)

const meta = {
  title: "Observability/WaterfallRow",
  component: WaterfallRow,
  args: {
    node: rootNode,
    totalMs,
    color: "var(--chart-1)",
  },
  decorators: [
    (Story) => (
      <ul className="w-[560px] px-3">
        <Story />
      </ul>
    ),
  ],
} satisfies Meta<typeof WaterfallRow>

export default meta
type Story = StoryObj<typeof meta>

export const RootSpan: Story = {}

export const ChildSpanWithEvents: Story = {
  args: { node: chatNode, color: "var(--chart-2)" },
}

export const ErrorSpan: Story = {
  args: { node: errorNode, color: "var(--destructive)" },
}
