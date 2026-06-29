import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LogDetailPanel } from "./log-detail-panel"
import { makeLogEntry, makeLogStream } from "@/lib/storybook/fixtures/logging"

// Pure: single-log drill-down (metadata grid, JSON tree, parsed stack frames,
// related-by-traceId list). The agent-trace tree only mounts for AGENT_TRACE
// module entries, so the default fixtures keep an empty Dexie quiet.
const meta = {
  title: "Logging/LogDetailPanel",
  component: LogDetailPanel,
  parameters: { layout: "fullscreen" },
  args: {
    onClose: fn(),
    onToggleBookmark: fn(),
    onSelectRelated: fn(),
    log: makeLogEntry({
      level: "info",
      message: "Request completed in 142ms",
      traceId: "trace-01aa11bb22",
      sessionId: "sess-42",
      tags: ["network", "lark"],
      data: { latencyMs: 142, endpoint: "/v1/messages", retries: 0 },
    }),
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LogDetailPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Info: Story = {}

// Error entry with a stack trace → parsed frames; first frame highlighted.
export const ErrorWithStack: Story = {
  args: {
    log: makeLogEntry({
      level: "error",
      message: "Failed to deliver message to channel #ops",
      traceId: "trace-09cc33dd",
      stack:
        "Error: Sandbox timed out after 30s\n    at execute (lib/sandbox.ts:88:12)\n    at runTool (lib/agent/run.ts:142:7)\n    at Object.dispatch (lib/agent/dispatch.ts:31:5)",
    }),
  },
}

// Related logs sharing the trace appear under the detail.
export const WithRelated: Story = {
  args: {
    isBookmarked: true,
    relatedLogs: makeLogStream(8).map((l) => ({ ...l, traceId: "trace-01aa11bb22" })),
  },
}
