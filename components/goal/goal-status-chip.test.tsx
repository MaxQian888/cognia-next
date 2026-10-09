import { render, screen } from "@testing-library/react"

import type { GoalStatus } from "@/types/goal"

import { GoalStatusChip } from "./goal-status-chip"
import { goalStatusStyle } from "./goal-status-style"

// next-intl globally mocked against en.json in jest.setup.ts.

describe("GoalStatusChip", () => {
  it.each<[GoalStatus, string]>([
    ["active", "active"],
    ["paused", "paused"],
    ["completed", "completed"],
    ["stopped", "stopped"],
    ["budget_limited", "budget limited"],
    ["turn_limited", "turn limited"],
    ["timed_out", "timed out"],
    ["preempted", "preempted"],
  ])("labels %s as %s and exposes it as data-status", (status, label) => {
    render(<GoalStatusChip goal={{ status }} />)
    const chip = screen.getByTestId("goal-status-chip")
    expect(chip).toHaveTextContent(label)
    expect(chip).toHaveAttribute("data-status", status)
    expect(chip).not.toHaveAttribute("data-awaiting")
  })

  it("says awaiting acceptance for a goal parked by the gate, in the paused tone", () => {
    render(<GoalStatusChip goal={{ status: "paused", awaitingAcceptance: true }} />)
    const chip = screen.getByTestId("goal-status-chip")
    expect(chip).toHaveTextContent("awaiting acceptance")
    expect(chip).not.toHaveTextContent(/^paused$/)
    expect(chip).toHaveAttribute("data-status", "paused")
    expect(chip).toHaveAttribute("data-awaiting", "true")
    for (const cls of goalStatusStyle("paused").chip.split(" ")) expect(chip).toHaveClass(cls)
  })

  it("ignores a stale awaiting flag on a goal that is no longer paused", () => {
    render(<GoalStatusChip goal={{ status: "active", awaitingAcceptance: true }} />)
    const chip = screen.getByTestId("goal-status-chip")
    expect(chip).toHaveTextContent("active")
    expect(chip).not.toHaveAttribute("data-awaiting")
  })

  it("pulses only while the goal runs", () => {
    const { container, rerender } = render(<GoalStatusChip goal={{ status: "active" }} />)
    expect(container.querySelector(".motion-safe\\:animate-ping")).not.toBeNull()
    rerender(<GoalStatusChip goal={{ status: "completed" }} />)
    expect(container.querySelector(".motion-safe\\:animate-ping")).toBeNull()
  })

  it("has a compact size and merges a className", () => {
    render(<GoalStatusChip goal={{ status: "active" }} size="sm" className="ml-2" />)
    expect(screen.getByTestId("goal-status-chip")).toHaveClass("text-[10px]", "ml-2")
  })
})
