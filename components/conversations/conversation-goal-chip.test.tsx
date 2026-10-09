/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import type { Goal } from "@/types/goal"
import { ConversationGoalChip, type ConversationGoalChipProps } from "./conversation-goal-chip"

type ChipGoal = ConversationGoalChipProps["goal"]

const goal = (over: Partial<Goal> = {}): ChipGoal =>
  ({
    id: "g1",
    status: "active",
    awaitingAcceptance: false,
    turnsUsed: 4,
    config: { maxTurns: 20 },
    safeObjective: "Ship the release notes",
    ...over,
  }) as ChipGoal

describe("ConversationGoalChip", () => {
  it("links to the goal in the Goals console", () => {
    render(<ConversationGoalChip goal={goal()} />)
    const chip = screen.getByTestId("conversation-goal-chip-g1")
    expect(chip.tagName).toBe("A")
    expect(chip).toHaveAttribute("href", "/goals?goal=g1")
    expect(chip).toHaveAttribute("title", "Ship the release notes")
  })

  it("shows an open goal in its status tone with the turns it has used", () => {
    render(<ConversationGoalChip goal={goal()} />)
    const chip = screen.getByRole("link", {
      name: "Goal active: Ship the release notes. Open it in Goals",
    })
    expect(chip).toHaveAttribute("data-open", "true")
    expect(chip).toHaveTextContent("active")
    expect(chip).toHaveTextContent("4/20")
    expect(chip.className).toContain("text-success")
    expect(chip.className).not.toContain("bg-muted")
  })

  it("counts a paused goal as open", () => {
    render(<ConversationGoalChip goal={goal({ status: "paused", turnsUsed: 7 })} />)
    const chip = screen.getByTestId("conversation-goal-chip-g1")
    expect(chip).toHaveAttribute("data-open", "true")
    expect(chip).toHaveTextContent("paused")
    expect(chip).toHaveTextContent("7/20")
  })

  it("says a goal parked for acceptance is awaiting it", () => {
    render(<ConversationGoalChip goal={goal({ status: "paused", awaitingAcceptance: true })} />)
    expect(
      screen.getByRole("link", {
        name: "Goal awaiting acceptance: Ship the release notes. Open it in Goals",
      })
    ).toHaveTextContent("awaiting acceptance")
  })

  it("mutes a finished goal and drops its turn count", () => {
    render(<ConversationGoalChip goal={goal({ status: "completed", turnsUsed: 20 })} />)
    const chip = screen.getByTestId("conversation-goal-chip-g1")
    expect(chip).not.toHaveAttribute("data-open")
    expect(chip).toHaveTextContent("completed")
    expect(chip).not.toHaveTextContent("20/20")
    expect(chip.className).toContain("bg-muted")
    expect(chip.className).toContain("text-muted-foreground")
  })

  it("keeps its click from reaching the row it sits on", () => {
    const onRowClick = jest.fn()
    render(
      <div onClick={onRowClick}>
        <ConversationGoalChip goal={goal()} />
      </div>
    )
    const chip = screen.getByTestId("conversation-goal-chip-g1")
    // Don't let jsdom attempt a navigation.
    chip.addEventListener("click", (event) => event.preventDefault())
    fireEvent.click(chip)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it("merges a caller's class names", () => {
    render(<ConversationGoalChip goal={goal()} className="ml-2" />)
    expect(screen.getByTestId("conversation-goal-chip-g1").className).toContain("ml-2")
  })
})
