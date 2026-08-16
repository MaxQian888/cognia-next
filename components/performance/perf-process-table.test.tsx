/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, within } from "@testing-library/react"

jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Area: () => <div data-testid="spark" />,
}))
jest.mock("@/hooks/logging/use-theme-colors", () => ({
  useThemeColors: () => ({ "chart-1": "#fff" }),
}))

import { PerfProcessTable } from "./perf-process-table"
import type { PerfSample, ProcessSample } from "@/lib/perf/backend/types"

function proc(
  pid: number,
  name: string,
  role: ProcessSample["role"],
  cpu: number,
  overrides: Partial<ProcessSample> = {}
): ProcessSample {
  return {
    pid,
    parentPid: role === "main" ? null : 1,
    name,
    role,
    cpuPct: cpu,
    cpuPctRaw: cpu,
    memBytes: 1024 * 1024 * pid,
    diskReadBps: 0,
    diskWriteBps: 0,
    runSecs: 60,
    ...overrides,
  }
}

/** Wrap one or more process snapshots into a sample history. */
function hist(...frames: ProcessSample[][]): PerfSample[] {
  return frames.map((processes, i) => ({
    tsMs: i + 1,
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
    managed: [],
  }))
}

describe("PerfProcessTable", () => {
  it("shows an empty state with no processes", () => {
    render(<PerfProcessTable history={[]} />)
    expect(screen.getByTestId("perf-proc-empty")).toBeInTheDocument()
  })

  it("renders a row per process with its role badge", () => {
    render(
      <PerfProcessTable
        history={hist([
          proc(1, "cognia", "main", 10),
          proc(2, "node", "sidecar", 30, { parentPid: null }),
        ])}
      />
    )
    expect(screen.getByTestId("perf-proc-row-1")).toBeInTheDocument()
    expect(screen.getByTestId("perf-proc-row-2")).toBeInTheDocument()
    expect(within(screen.getByTestId("perf-proc-row-1")).getByText("Main")).toBeInTheDocument()
    expect(within(screen.getByTestId("perf-proc-row-2")).getByText("Sidecar")).toBeInTheDocument()
  })

  it("renders the tree-wide summary cards", () => {
    render(
      <PerfProcessTable
        history={hist([
          proc(1, "cognia", "main", 10),
          proc(2, "node", "sidecar", 30, { parentPid: null }),
        ])}
      />
    )
    expect(screen.getByTestId("perf-proc-total-count")).toHaveTextContent("2")
    // 10% + 30% = 40% combined tree CPU.
    expect(screen.getByTestId("perf-proc-total-cpu")).toHaveTextContent("40.0%")
    expect(screen.getByTestId("perf-proc-total-mem")).toBeInTheDocument()
    expect(screen.getByTestId("perf-proc-total-disk")).toBeInTheDocument()
  })

  it("renders a CPU trend sparkline, uptime, and memory-share bar per row", () => {
    render(
      <PerfProcessTable
        history={hist(
          [proc(1, "cognia", "main", 5)],
          [proc(1, "cognia", "main", 20, { runSecs: 3661 })]
        )}
      />
    )
    expect(screen.getByTestId("perf-proc-trend-1")).toBeInTheDocument()
    expect(screen.getByTestId("perf-proc-mem-share-1")).toBeInTheDocument()
    // 3661s → "1h 1m"
    expect(screen.getByTestId("perf-proc-row-1")).toHaveTextContent("1h 1m")
  })

  it("sorts by CPU descending by default and toggles direction on header click", () => {
    render(
      <PerfProcessTable
        history={hist([
          proc(1, "cognia", "main", 10),
          proc(2, "node", "sidecar", 30, { parentPid: null }),
        ])}
      />
    )
    const rowsDesc = screen.getAllByTestId(/perf-proc-row-/)
    expect(rowsDesc[0]).toHaveAttribute("data-testid", "perf-proc-row-2")

    fireEvent.click(within(screen.getByTestId("perf-proc-th-cpuPct")).getByRole("button"))
    const rowsAsc = screen.getAllByTestId(/perf-proc-row-/)
    expect(rowsAsc[0]).toHaveAttribute("data-testid", "perf-proc-row-1")
    expect(screen.getByTestId("perf-proc-th-cpuPct")).toHaveAttribute("aria-sort", "ascending")
  })

  it("sorts by uptime when the uptime header is clicked", () => {
    render(
      <PerfProcessTable
        history={hist([
          proc(1, "cognia", "main", 10, { runSecs: 10 }),
          proc(2, "node", "sidecar", 30, { runSecs: 999, parentPid: null }),
        ])}
      />
    )
    fireEvent.click(within(screen.getByTestId("perf-proc-th-runSecs")).getByRole("button"))
    // Descending by uptime: pid 2 (999s) first.
    expect(screen.getAllByTestId(/perf-proc-row-/)[0]).toHaveAttribute(
      "data-testid",
      "perf-proc-row-2"
    )
  })

  it("sorts by name when the name header is clicked", () => {
    render(
      <PerfProcessTable
        history={hist([
          proc(1, "zeta", "main", 10),
          proc(2, "alpha", "child", 5, { parentPid: null }),
        ])}
      />
    )
    fireEvent.click(within(screen.getByTestId("perf-proc-th-name")).getByRole("button"))
    const rows = screen.getAllByTestId(/perf-proc-row-/)
    expect(rows[0]).toHaveAttribute("data-testid", "perf-proc-row-2")
  })

  it("exposes each sortable header as a keyboard-operable button", () => {
    // Regression: the sort handler used to sit on the bare <th>, so the whole
    // table could only be re-sorted with a mouse.
    render(
      <PerfProcessTable
        history={hist([proc(1, "cognia", "main", 10), proc(2, "node", "sidecar", 30)])}
      />
    )
    const sortButton = within(screen.getByTestId("perf-proc-th-name")).getByRole("button")
    sortButton.focus()
    expect(sortButton).toHaveFocus()

    fireEvent.keyDown(sortButton, { key: "Enter" })
    fireEvent.click(sortButton) // what the browser dispatches for Enter on a button
    expect(screen.getByTestId("perf-proc-th-name")).toHaveAttribute("aria-sort", "ascending")
  })

  it("builds one CPU series per process across the whole window", () => {
    // The series must stay window-length and zero-filled for frames where the
    // PID is absent, so every sparkline lines up with the others.
    const history: PerfSample[] = [
      hist([proc(1, "cognia", "main", 10)])[0],
      hist([proc(1, "cognia", "main", 20), proc(2, "node", "sidecar", 40)])[0],
    ]
    render(<PerfProcessTable history={history} />)
    expect(screen.getByTestId("perf-proc-trend-1")).toBeInTheDocument()
    expect(screen.getByTestId("perf-proc-trend-2")).toBeInTheDocument()
  })

  it("gives the search input an accessible name", () => {
    render(<PerfProcessTable history={hist([proc(1, "cognia", "main", 10)])} />)
    expect(screen.getByTestId("perf-proc-search")).toHaveAccessibleName()
  })

  it("renders a search input", () => {
    render(<PerfProcessTable history={hist([proc(1, "cognia", "main", 10)])} />)
    expect(screen.getByTestId("perf-proc-search")).toBeInTheDocument()
  })

  it("retains ancestors while filtering descendants by name", () => {
    render(
      <PerfProcessTable
        history={hist([proc(1, "cognia", "main", 10), proc(2, "node", "sidecar", 30)])}
      />
    )
    fireEvent.change(screen.getByTestId("perf-proc-search"), { target: { value: "node" } })
    expect(screen.getByTestId("perf-proc-row-1")).toBeInTheDocument()
    expect(screen.getByTestId("perf-proc-row-2")).toBeInTheDocument()
  })

  it("retains ancestors while filtering descendants by PID", () => {
    render(
      <PerfProcessTable
        history={hist([proc(1, "cognia", "main", 10), proc(2, "node", "sidecar", 30)])}
      />
    )
    fireEvent.change(screen.getByTestId("perf-proc-search"), { target: { value: "2" } })
    expect(screen.getByTestId("perf-proc-row-1")).toBeInTheDocument()
    expect(screen.getByTestId("perf-proc-row-2")).toBeInTheDocument()
  })

  it("shows no-match state when filter yields nothing", () => {
    render(<PerfProcessTable history={hist([proc(1, "cognia", "main", 10)])} />)
    fireEvent.change(screen.getByTestId("perf-proc-search"), { target: { value: "xyz" } })
    expect(screen.getByTestId("perf-proc-no-match")).toBeInTheDocument()
    expect(screen.queryByTestId("perf-proc-row-1")).not.toBeInTheDocument()
  })

  it("restores all rows when search is cleared", () => {
    render(
      <PerfProcessTable
        history={hist([proc(1, "cognia", "main", 10), proc(2, "node", "sidecar", 30)])}
      />
    )
    fireEvent.change(screen.getByTestId("perf-proc-search"), { target: { value: "node" } })
    expect(screen.getByTestId("perf-proc-row-1")).toBeInTheDocument()

    fireEvent.change(screen.getByTestId("perf-proc-search"), { target: { value: "" } })
    expect(screen.getByTestId("perf-proc-row-1")).toBeInTheDocument()
    expect(screen.getByTestId("perf-proc-row-2")).toBeInTheDocument()
  })

  it("applies heat-map coloring to CPU cells by intensity", () => {
    const procFull = (pid: number, cpu: number, mem: number): ProcessSample =>
      proc(pid, `proc-${pid}`, "child", cpu, { memBytes: mem })

    render(
      <PerfProcessTable
        history={hist([
          procFull(1, 5, 1024 * 1024),
          procFull(2, 40, 1024 * 1024 * 2),
          procFull(3, 70, 1024 * 1024 * 3),
          procFull(4, 90, 1024 * 1024 * 4),
        ])}
      />
    )

    const cpu1 = screen.getByTestId("perf-proc-cpu-1")
    expect(cpu1.className).not.toContain("bg-yellow")
    expect(cpu1.className).not.toContain("bg-orange")
    expect(cpu1.className).not.toContain("bg-red")
    expect(screen.getByTestId("perf-proc-cpu-2").className).toContain("bg-yellow")
    expect(screen.getByTestId("perf-proc-cpu-3").className).toContain("bg-orange")
    expect(screen.getByTestId("perf-proc-cpu-4").className).toContain("bg-red")
  })

  it("applies relative heat-map coloring to memory cells", () => {
    const procFull = (pid: number, mem: number): ProcessSample =>
      proc(pid, `proc-${pid}`, "child", 0, { memBytes: mem })

    render(
      <PerfProcessTable
        history={hist([
          procFull(1, 1024 * 1024),
          procFull(2, 1024 * 1024 * 4),
          procFull(3, 1024 * 1024 * 7),
          procFull(4, 1024 * 1024 * 10),
        ])}
      />
    )

    expect(screen.getByTestId("perf-proc-mem-1").className).not.toContain("bg-yellow")
    expect(screen.getByTestId("perf-proc-mem-2").className).toContain("bg-yellow")
    expect(screen.getByTestId("perf-proc-mem-3").className).toContain("bg-orange")
    expect(screen.getByTestId("perf-proc-mem-4").className).toContain("bg-red")
  })
})
