import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LogTraceView } from "./log-trace-view"
import { makeLogStream } from "@/lib/storybook/fixtures/logging"

// Pure: groups `filteredLogs` by traceId into trace rows with a mini timeline.
// Entries without a traceId are excluded; all-untraced → explanatory empty.
const meta = {
  title: "Logging/LogTraceView",
  component: LogTraceView,
  parameters: { layout: "padded" },
  args: {
    filteredLogs: makeLogStream(80),
    onSelectTrace: fn(),
  },
} satisfies Meta<typeof LogTraceView>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

// No entry carries a traceId → the "no trace events" empty state.
export const Empty: Story = {
  args: {
    filteredLogs: makeLogStream(20).map((l) => ({ ...l, traceId: undefined })),
  },
}
