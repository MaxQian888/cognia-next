import type { Meta, StoryObj } from "@storybook/nextjs"

import { PerfManagedProcesses } from "./perf-managed-processes"
import type { PerfSample } from "@/lib/perf/backend/types"

const MB = 1024 * 1024

const runtime: PerfSample["runtime"] = {
  workers: 8,
  aliveTasks: 12,
  globalQueueDepth: 0,
  blockingThreads: 1,
  blockingQueueDepth: 0,
  spawnedTasksCount: 0,
  budgetForcedYieldCount: 0,
  workerStealCount: 0,
  workerParkCount: 0,
  workerOverflowCount: 0,
  busyPct: 20,
  perWorkerBusyPct: [20],
}

// A live frame with a managed process per in-scope subsystem, each joined to a
// sampled OS process by PID (except the MCP server, whose PID is unset here).
const latest: PerfSample = {
  tsMs: 1,
  intervalMs: 1000,
  processes: [
    { pid: 100, parentPid: 1, name: "npx", role: "child", cpuPct: 12, cpuPctRaw: 96, memBytes: 220 * MB, diskReadBps: 0, diskWriteBps: 0, runSecs: 340 }, // prettier-ignore
    { pid: 200, parentPid: 1, name: "node", role: "sidecar", cpuPct: 3, cpuPctRaw: 24, memBytes: 180 * MB, diskReadBps: 0, diskWriteBps: 0, runSecs: 1200 }, // prettier-ignore
    { pid: 300, parentPid: 1, name: "zsh", role: "child", cpuPct: 0.4, cpuPctRaw: 3, memBytes: 12 * MB, diskReadBps: 0, diskWriteBps: 0, runSecs: 90 }, // prettier-ignore
  ],
  runtime,
  topSpans: [],
  systemMemory: null,
  managed: [
    { subsystem: "externalAgent", id: "cfg-codex", name: "npx", pid: 100, status: "running", canKill: true, canRestart: true, detail: null }, // prettier-ignore
    { subsystem: "chatSidecar", id: "chat-sidecar", name: "claude-host.mjs", pid: 200, status: "running", canKill: true, canRestart: false, detail: null }, // prettier-ignore
    { subsystem: "mcpServer", id: "mcp-server", name: "127.0.0.1:8765", pid: null, status: "running", canKill: true, canRestart: false, detail: "2026-07-17T00:00:00Z" }, // prettier-ignore
    { subsystem: "integratedTerminal", id: "pty-1", name: "/bin/zsh", pid: 300, status: "running", canKill: true, canRestart: false, detail: "proj-a" }, // prettier-ignore
  ],
}

const meta = {
  title: "Performance/PerfManagedProcesses",
  component: PerfManagedProcesses,
  args: { latest },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PerfManagedProcesses>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

// No managed processes → the empty-state copy.
export const Empty: Story = {
  args: { latest: { ...latest, managed: [] } },
}
