import type { Meta, StoryObj } from "@storybook/nextjs"
import { recordRecentErrorLog, resetRecentErrorLogsForTest } from "@cognia/logging/recent-errors"
import type { StructuredLogEntry } from "@cognia/logging/types/log-entry"

import { CrashDiagnosticsWorkspace } from "./crash-diagnostics-workspace"

// `useCrashLogs` merges three sources: the in-memory recent-error buffer, the
// IndexedDB log transport, and the native diagnostics snapshot. Only the first
// exists in a browser preview, so the stories seed it directly — that is the
// realistic browser-mode surface anyway (no native host, no persisted rows).
const SEED: StructuredLogEntry[] = [
  {
    id: "seed-fatal",
    timestamp: new Date("2026-06-01T10:04:12.926Z").toISOString(),
    level: "fatal",
    message: "Route boundary tripped",
    module: "app",
    traceId: "3f9a1c8e2b7d4f60",
    stack: "ReferenceError: executionGroup is not defined\n    at GenericBottomToolbar",
    data: {
      errorName: "ReferenceError",
      errorMessage: "executionGroup is not defined",
      category: "render",
      pathname: "/",
    },
  },
  {
    id: "seed-error-sidecar",
    timestamp: new Date("2026-06-01T09:58:03.114Z").toISOString(),
    level: "error",
    message: "Sidecar exited before the first turn",
    module: "sidecar",
    traceId: "0a44bd7719e04c11",
    data: { exitCode: 1, restarts: 3 },
  },
  {
    id: "seed-error-connector",
    timestamp: new Date("2026-06-01T09:41:47.500Z").toISOString(),
    level: "error",
    message: "Outbound delivery rejected by the bus",
    module: "connectors",
    data: { adapter: "lark", reason: "quiet_hours" },
  },
]

const meta = {
  title: "Logging/CrashDiagnosticsWorkspace",
  component: CrashDiagnosticsWorkspace,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[720px] flex-col overflow-hidden border-t">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CrashDiagnosticsWorkspace>

export default meta
type Story = StoryObj<typeof meta>

/** Crashes present: list, counts strip as the level filter, and the detail pane. */
export const WithCrashes: Story = {
  loaders: [
    () => {
      resetRecentErrorLogsForTest()
      for (const entry of [...SEED].reverse()) recordRecentErrorLog(entry)
      return {}
    },
  ],
}

/** The state most installs are in — nothing has gone wrong yet. */
export const Empty: Story = {
  loaders: [
    () => {
      resetRecentErrorLogsForTest()
      return {}
    },
  ],
}
