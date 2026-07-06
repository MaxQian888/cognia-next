import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentTraceTreeView } from "./agent-trace-tree"
import { makeWindowSpans } from "@/lib/storybook/fixtures/observability"

// `AgentTraceTreeView` is the pure surface (the Dexie live-query lives in the
// `AgentTraceTree` wrapper). One connected trace = root invoke_agent → child
// chat + execute_tool. `spans === null` is loading; `[]` is empty.
const traceSpans = makeWindowSpans().filter((s) => s.traceId === "trace-01")

const meta = {
  title: "Logging/AgentTraceTree",
  component: AgentTraceTreeView,
  parameters: { layout: "padded" },
  args: { spans: traceSpans, activeSpanId: traceSpans[1]?.id },
} satisfies Meta<typeof AgentTraceTreeView>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

export const Loading: Story = { args: { spans: null } }

export const Empty: Story = { args: { spans: [] } }
