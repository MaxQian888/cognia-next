import { fireEvent, render, screen } from "@testing-library/react"

import { SchedulerListRow } from "./scheduler-list-row"
import { HOVER_REVEAL_REQUIRED_VARIANTS } from "@/lib/ui/hover-reveal"
import type { AttentionSignal } from "@/lib/scheduler/attention"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "app:t1",
    kind: "app",
    sourceId: "t1",
    name: "Nightly build",
    status: "active",
    triggerSummary: { type: "cron", cron: "0 2 * * *" },
    nextRunAt: Date.now() + 2 * 3_600_000,
    origin: { deepLinkHref: "/scheduler?taskId=t1" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  }
}

const baseProps = {
  selected: false,
  checked: false,
  onSelect: jest.fn(),
  onToggleCheck: jest.fn(),
}

describe("SchedulerListRow", () => {
  it("is one button that selects the item, with the trigger and next run", () => {
    const onSelect = jest.fn()
    render(<SchedulerListRow {...baseProps} item={item()} signal={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("button", { name: /Nightly build/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ unifiedId: "app:t1" }))
    expect(screen.getByText("0 2 * * *")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-list-row-next")).toHaveTextContent(/1h|2h/)
    expect(screen.queryByTestId("scheduler-list-row-signal")).not.toBeInTheDocument()
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("replaces the trigger line with the attention signal", () => {
    const signal: AttentionSignal = {
      id: "consecutive-failures:app:t1",
      kind: "consecutive-failures",
      severity: "critical",
      itemUnifiedId: "app:t1",
      count: 3,
    }
    render(<SchedulerListRow {...baseProps} item={item()} signal={signal} />)
    const line = screen.getByTestId("scheduler-list-row-signal")
    expect(line).toHaveTextContent("3 failures in a row")
    expect(line.dataset.severity).toBe("critical")
    expect(screen.queryByText("0 2 * * *")).not.toBeInTheDocument()
  })

  it("phrases every item signal", () => {
    const cases: [AttentionSignal["kind"], Partial<AttentionSignal>, string][] = [
      ["auto-paused", { count: 4 }, "Paused itself after 4 failures"],
      ["last-run-failed", {}, "Last run failed"],
      ["last-run-failed", { detail: "boom" }, "Last run failed: boom"],
      ["unsupported-type", {}, "Cannot run on this host"],
      ["running", {}, "Running now"],
      ["running", { processCount: 2 }, "Running now, 2 live processes"],
    ]
    for (const [kind, extra, text] of cases) {
      const { unmount } = render(
        <SchedulerListRow
          {...baseProps}
          item={item()}
          signal={{ id: kind, kind, severity: "info", itemUnifiedId: "app:t1", ...extra }}
        />
      )
      expect(screen.getByTestId("scheduler-list-row-signal")).toHaveTextContent(text)
      unmount()
    }
  })

  it("marks selection, and toggles the checkbox without selecting", () => {
    const onSelect = jest.fn()
    const onToggleCheck = jest.fn()
    render(
      <SchedulerListRow
        {...baseProps}
        item={item({ createdBySource: "agent", nextRunAt: undefined })}
        signal={null}
        selected
        onSelect={onSelect}
        onToggleCheck={onToggleCheck}
      />
    )
    expect(screen.getByRole("button", { name: /Nightly build/ })).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(screen.getByTestId("authored-by-agent")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-list-row-next")).toHaveTextContent("No schedule")
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row" }))
    expect(onToggleCheck).toHaveBeenCalledWith(expect.objectContaining({ unifiedId: "app:t1" }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("keeps the multi-select checkbox reachable without a hover", () => {
    const onToggleCheck = jest.fn()
    render(
      <SchedulerListRow {...baseProps} item={item()} signal={null} onToggleCheck={onToggleCheck} />
    )
    const slot = screen.getByTestId("scheduler-list-row-check-slot")
    // Focus, touch and an open popup reveal it too; it only ever fades.
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.group) {
      expect(slot).toHaveClass(variant)
    }
    expect(slot).toHaveClass("opacity-0")
    expect(slot).not.toHaveClass("invisible", "hidden", "pointer-events-none")

    const checkbox = screen.getByRole("checkbox", { name: "Select row" })
    checkbox.focus()
    expect(checkbox).toHaveFocus()
    fireEvent.click(checkbox)
    expect(onToggleCheck).toHaveBeenCalledWith(expect.objectContaining({ unifiedId: "app:t1" }))
  })

  it("keeps every checkbox resident during a bulk session", () => {
    render(<SchedulerListRow {...baseProps} item={item()} signal={null} checkMode />)
    expect(screen.getByTestId("scheduler-list-row-check-slot")).not.toHaveClass("opacity-0")
  })
})

it("shows the stable task identifier when its name is ambiguous", () => {
  const task = item()
  render(<SchedulerListRow {...baseProps} item={task} signal={null} showIdentity />)
  expect(screen.getByTitle(task.unifiedId)).toHaveTextContent(task.sourceId)
})
