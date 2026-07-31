import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LspLogsDialog } from "./lsp-logs-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useLspStatusStore } from "@/lib/lsp/lsp-status-store"

// `LspLogsDialog` is a read-only viewer over the sidecar LSP log ring buffer
// (`useLspStatusStore.logs`). Prop-driven open state; it calls `loadLogs()` on
// first open (a no-op on the web preview, where the status store is inert).
const sampleLogs = [
  {
    ts: Date.now() - 8000,
    serverId: "typescript",
    level: "info",
    message: "server started (pid 4821)",
  },
  {
    ts: Date.now() - 5000,
    serverId: "pyright",
    level: "warn",
    message: "no pyrightconfig.json found, using defaults",
  },
  {
    ts: Date.now() - 1500,
    serverId: "rust-analyzer",
    level: "error",
    message: "crashed: exit code 101; restart scheduled",
  },
]

const meta = {
  title: "Settings/Lsp/LspLogsDialog",
  component: LspLogsDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
  },
  beforeEach: () => {
    resetStore(useLspStatusStore)
  },
} satisfies Meta<typeof LspLogsDialog>

export default meta
type Story = StoryObj<typeof meta>

// Open with no buffered logs — the empty state.
export const Empty: Story = {}

// Open with a few buffered log lines across levels.
export const WithLogs: Story = {
  beforeEach: () => {
    resetStore(useLspStatusStore)
    seedStore(useLspStatusStore, { logs: sampleLogs } as never)
  },
}
