import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LogPanelStatsBar, TransportHealthSummary } from "./log-panel-stats-bar"
import type { TransportHealthSnapshot } from "@cognia/logging"
import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"

const NOW = new Date().toISOString()

const health = (over: Partial<TransportHealthSnapshot>): TransportHealthSnapshot => ({
  transport: "indexedDB",
  status: "healthy",
  queueDepth: 0,
  retryCount: 0,
  droppedEntries: 0,
  lastSuccessAt: NOW,
  updatedAt: NOW,
  ...over,
})

// Web runtime → the native tile is omitted (only the IndexedDB/remote tiles
// show). The stats bar is pure presentation.
const NATIVE_WEB: NativeLoggingReadiness = {
  runtime: "web",
  status: "inactive",
  startupMode: "disabled",
  startupHealth: "inactive",
  activeTargets: [],
  bridgeState: "inactive",
  platformLogging: {
    available: false,
    backend: "none",
    health: "inactive",
    enabled: true,
    minLevel: "warn",
  },
  updatedAt: NOW,
}

const meta = {
  title: "Logging/LogPanelStatsBar",
  component: LogPanelStatsBar,
  parameters: { layout: "fullscreen" },
  args: {
    logRate: 42,
    autoRefresh: true,
    windowCapped: false,
    windowSize: 1000,
  },
  decorators: [
    (Story) => (
      <div className="w-full border rounded-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LogPanelStatsBar>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

// The loaded window is full: the info button explains the newest-N limit.
export const WindowFull: Story = {
  args: { windowCapped: true },
}

// The transport chip the panel renders beside Live / Refresh, with one
// degraded and one offline transport sitting inline.
export const TransportHealth: Story = {
  render: () => (
    <TransportHealthSummary
      healthByTransport={{
        indexedDB: health({ transport: "indexedDB", queueDepth: 3 }),
        remote: health({ transport: "remote", status: "degraded", queueDepth: 28, retryCount: 4 }),
        otel: health({
          transport: "otel",
          status: "offline",
          queueDepth: 120,
          droppedEntries: 14,
          lastFailureAt: NOW,
          lastError: "ECONNREFUSED",
        }),
      }}
      nativeLogging={NATIVE_WEB}
      onTransportClick={fn()}
      onNativeLoggingClick={fn()}
    />
  ),
}
