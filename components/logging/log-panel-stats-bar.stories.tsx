import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LogPanelStatsBar } from "./log-panel-stats-bar"
import type { TransportHealthSnapshot } from "@/lib/logging"
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
    filteredCount: 1240,
    totalCount: 4096,
    stats: { byLevel: { trace: 80, debug: 420, info: 600, warn: 110, error: 30, fatal: 0 } },
    logRate: 42,
    autoRefresh: true,
    healthByTransport: {
      indexedDB: health({ transport: "indexedDB", queueDepth: 3 }),
      remote: health({ transport: "remote", status: "degraded", queueDepth: 28, retryCount: 4 }),
    },
    nativeLogging: NATIVE_WEB,
    onTransportClick: fn(),
    onNativeLoggingClick: fn(),
    currentPage: 2,
    totalPages: 9,
    pageSize: 50,
    pageSizeOptions: [25, 50, 100],
    onPageChange: fn(),
    onPageSizeChange: fn(),
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

// A dropped/offline transport tile and a single page (pagination hidden).
export const SinglePageWithDrops: Story = {
  args: {
    filteredCount: 12,
    totalCount: 12,
    currentPage: 1,
    totalPages: 1,
    healthByTransport: {
      remote: health({
        transport: "remote",
        status: "offline",
        queueDepth: 120,
        droppedEntries: 14,
        lastFailureAt: NOW,
        lastError: "ECONNREFUSED",
      }),
    },
  },
}

export const NoLogs: Story = {
  args: {
    filteredCount: 0,
    totalCount: 0,
    logRate: 0,
    stats: { byLevel: { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 } },
    currentPage: 1,
    totalPages: 1,
  },
}
