import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConnectionDiagnosticsSheet } from "./connection-diagnostics-sheet"

// WebRTC tier + per-table sync diagnostics. Pure props (open / onOpenChange):
// it reads the in-memory sync snapshot (dormant + empty in the Storybook
// browser, so every table shows "never") and subscribes to transport tier
// changes only while open. `runSyncDown`/`reconnectRtc` fire only on taps.
const meta = {
  title: "Mobile/ConnectionStateSheets/ConnectionDiagnosticsSheet",
  component: ConnectionDiagnosticsSheet,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof ConnectionDiagnosticsSheet>

export default meta
type Story = StoryObj<typeof meta>

/** Open sheet — offline tier, all sync tables yet to run. */
export const Open: Story = {}
