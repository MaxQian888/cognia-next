import type { Meta, StoryObj } from "@storybook/nextjs"
import { useTranslations } from "next-intl"
import { fn } from "storybook/test"

import { LogEntry, type LogEntryProps } from "./log-entry"
import { makeLogEntry } from "@/lib/storybook/fixtures/logging"

// `LogEntry` takes a bound `t` (so `React.memo` short-circuits in the real
// virtualized list). A harness injects it from `useTranslations("logging")` so
// stories only supply the data/handler props.
function LogEntryHarness(props: Omit<LogEntryProps, "t">) {
  const t = useTranslations("logging")
  return <LogEntry {...props} t={t} />
}

const meta = {
  title: "Logging/LogEntry",
  component: LogEntryHarness,
  parameters: { layout: "padded" },
  args: {
    isExpanded: false,
    onToggle: fn(),
    onSelect: fn(),
    onToggleBookmark: fn(),
    searchQuery: "",
    useRegex: false,
    isBookmarked: false,
    log: makeLogEntry({ level: "info", message: "Request completed in 142ms" }),
  },
} satisfies Meta<typeof LogEntryHarness>

export default meta
type Story = StoryObj<typeof meta>

export const Info: Story = {}

export const Warning: Story = {
  args: {
    log: makeLogEntry({ level: "warn", message: "Retrying request (attempt 2)" }),
  },
}

// Error entries carry a stack + data; expanded shows the detail region.
export const ErrorExpanded: Story = {
  args: {
    isExpanded: true,
    log: makeLogEntry({
      level: "error",
      message: "Failed to deliver message to channel #ops",
      traceId: "trace-01aa11bb22",
      sessionId: "sess-42",
      stack:
        "Error: Sandbox timed out after 30s\n    at execute (lib/sandbox.ts:88:12)\n    at runTool (lib/agent/run.ts:142:7)",
      data: { channelId: "ops", attempts: 3 },
      source: { file: "lib/connectors/outbound.ts", line: 210, function: "deliver" },
    }),
  },
}

export const Bookmarked: Story = {
  args: {
    isBookmarked: true,
    log: makeLogEntry({ level: "debug", message: "Resolved tool args", traceId: "trace-77ffee" }),
  },
}

// Search highlighting: matching substrings are wrapped in <mark>.
export const SearchHighlight: Story = {
  args: {
    searchQuery: "completed",
    log: makeLogEntry({ level: "info", message: "Request completed in 142ms" }),
  },
}
