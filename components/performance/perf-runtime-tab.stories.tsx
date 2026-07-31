import type { Meta, StoryObj } from "@storybook/nextjs"

import { PerfRuntimeTab } from "./perf-runtime-tab"
import { makeHistory, makeRuntime } from "@/lib/storybook/fixtures/performance"

const history = makeHistory(40)

// Tokio runtime detail: Workers / Tasks / Queues / Throughput KPI cards, a
// per-worker busy-% card with sparklines, and the flight-recorder trace list
// (empty on web since the Tauri command is a no-op).
const meta = {
  title: "Performance/PerfRuntimeTab",
  component: PerfRuntimeTab,
  args: { runtime: makeRuntime(), history },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PerfRuntimeTab>

export default meta
type Story = StoryObj<typeof meta>

export const Healthy: Story = {}

// busyPct above the 80% saturation threshold flips the busy KPI to destructive.
export const Saturated: Story = {
  args: {
    runtime: makeRuntime({ busyPct: 92, perWorkerBusyPct: [95, 88, 91, 99, 84, 90, 87, 93] }),
  },
}

export const Empty: Story = {
  args: { runtime: null },
}
