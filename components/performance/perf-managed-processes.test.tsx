/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react"

jest.mock("@/lib/perf/backend/managed-control", () => ({
  controlManaged: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { PerfManagedProcesses } from "./perf-managed-processes"
import { controlManaged } from "@/lib/perf/backend/managed-control"
import { toast } from "sonner"
import type { ManagedProcess, PerfSample, ProcessSample } from "@/lib/perf/backend/types"

const mockControl = controlManaged as jest.Mock

function proc(pid: number, over: Partial<ProcessSample> = {}): ProcessSample {
  return {
    pid,
    parentPid: 1,
    name: `p${pid}`,
    role: "child",
    cpuPct: 5,
    cpuPctRaw: 5,
    memBytes: 1024 * 1024 * pid,
    diskReadBps: 0,
    diskWriteBps: 0,
    runSecs: 60,
    ...over,
  }
}

function mp(over: Partial<ManagedProcess> = {}): ManagedProcess {
  return {
    subsystem: "externalAgent",
    id: "a1",
    name: "npx",
    pid: 100,
    status: "running",
    canKill: true,
    canRestart: true,
    detail: null,
    ...over,
  }
}

function sample(managed: ManagedProcess[], processes: ProcessSample[] = []): PerfSample {
  return {
    tsMs: 1,
    intervalMs: 1000,
    processes,
    runtime: {
      workers: 1,
      aliveTasks: 0,
      globalQueueDepth: 0,
      blockingThreads: 0,
      blockingQueueDepth: 0,
      spawnedTasksCount: 0,
      budgetForcedYieldCount: 0,
      workerStealCount: 0,
      workerParkCount: 0,
      workerOverflowCount: 0,
      busyPct: 0,
      perWorkerBusyPct: [0],
    },
    topSpans: [],
    systemMemory: null,
    managed,
  }
}

describe("PerfManagedProcesses", () => {
  beforeEach(() => jest.clearAllMocks())

  it("shows an empty state when there are no managed processes", () => {
    render(<PerfManagedProcesses latest={null} />)
    expect(screen.getByTestId("perf-managed-empty")).toBeInTheDocument()

    render(<PerfManagedProcesses latest={sample([])} />)
    expect(screen.getAllByTestId("perf-managed-empty").length).toBeGreaterThan(0)
  })

  it("groups rows by subsystem and joins CPU/memory by PID", () => {
    render(
      <PerfManagedProcesses
        latest={sample(
          [
            mp({ id: "a1", pid: 100 }),
            mp({
              subsystem: "chatSidecar",
              id: "chat-sidecar",
              name: "claude-host.mjs",
              pid: 200,
              canRestart: false,
            }),
          ],
          [proc(100, { cpuPct: 12 }), proc(200, { cpuPct: 3 })]
        )}
      />
    )
    expect(screen.getByTestId("perf-managed-group-externalAgent")).toBeInTheDocument()
    expect(screen.getByTestId("perf-managed-group-chatSidecar")).toBeInTheDocument()
    // Joined CPU shows in the external-agent row.
    expect(within(screen.getByTestId("perf-managed-row-a1")).getByText("12.0%")).toBeInTheDocument()
    // Summary: 2 managed, 2 running.
    expect(screen.getByTestId("perf-managed-count")).toHaveTextContent("2")
    expect(screen.getByTestId("perf-managed-running")).toHaveTextContent("2")
  })

  it("renders an em dash when no OS process matches the PID", () => {
    render(<PerfManagedProcesses latest={sample([mp({ id: "a1", pid: 999 })], [])} />)
    // No matching ProcessSample → CPU/mem/uptime dashed.
    expect(screen.getByTestId("perf-managed-row-a1")).toHaveTextContent("—")
  })

  it("disables restart for subsystems that don't support it", () => {
    render(
      <PerfManagedProcesses
        latest={sample([
          mp({ subsystem: "acpTerminal", id: "t1", name: "cat", canRestart: false }),
        ])}
      />
    )
    expect(screen.getByTestId("perf-managed-restart-t1")).toBeDisabled()
    expect(screen.getByTestId("perf-managed-kill-t1")).toBeEnabled()
  })

  it("restarts an external agent directly (no confirm dialog)", async () => {
    render(<PerfManagedProcesses latest={sample([mp({ id: "a1" })])} />)
    fireEvent.click(screen.getByTestId("perf-managed-restart-a1"))
    await waitFor(() =>
      expect(mockControl).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "restart")
    )
    expect(toast.success).toHaveBeenCalled()
  })

  it("confirms before killing, then routes the kill through controlManaged", async () => {
    render(<PerfManagedProcesses latest={sample([mp({ id: "a1", name: "npx" })])} />)
    fireEvent.click(screen.getByTestId("perf-managed-kill-a1"))

    const dialog = await screen.findByTestId("perf-managed-kill-dialog")
    expect(dialog).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("perf-managed-kill-confirm"))
    await waitFor(() =>
      expect(mockControl).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "kill")
    )
  })

  it("cancelling the kill dialog does not control the process", async () => {
    render(<PerfManagedProcesses latest={sample([mp({ id: "a1" })])} />)
    fireEvent.click(screen.getByTestId("perf-managed-kill-a1"))
    await screen.findByTestId("perf-managed-kill-dialog")

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByTestId("perf-managed-kill-dialog")).not.toBeInTheDocument()
    )
    expect(mockControl).not.toHaveBeenCalled()
  })

  it("surfaces an error toast when the control action fails", async () => {
    mockControl.mockRejectedValueOnce(new Error("boom"))
    render(<PerfManagedProcesses latest={sample([mp({ id: "a1" })])} />)
    fireEvent.click(screen.getByTestId("perf-managed-restart-a1"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("renders the detail column and dashes a null-pid row", () => {
    render(
      <PerfManagedProcesses
        latest={sample([
          mp({
            subsystem: "mcpServer",
            id: "mcp-server",
            name: "127.0.0.1:8765",
            pid: null,
            canRestart: false,
            detail: "2026-07-17T00:00:00Z",
          }),
        ])}
      />
    )
    const row = screen.getByTestId("perf-managed-row-mcp-server")
    expect(within(row).getByText("2026-07-17T00:00:00Z")).toBeInTheDocument()
    expect(row).toHaveTextContent("—")
  })
})
