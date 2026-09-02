/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SquadRunChip } from "./squad-run-chip"

const run = { runId: "r1", teamId: "team x", teamName: "Docs squad", status: "running" as const }

describe("SquadRunChip", () => {
  it("links to the squad's workspace with the team selected", () => {
    render(<SquadRunChip run={run} />)
    const chip = screen.getByTestId("squad-run-chip-team x")
    expect(chip).toHaveAttribute("href", "/squads?id=team%20x")
    expect(chip).toHaveTextContent("label:Docs squad")
    expect(chip).toHaveAttribute("aria-label", "open:Docs squad")
    expect(chip).toHaveAttribute("data-run-status", "running")
  })

  it("falls back to a generic name when the team is gone", () => {
    render(<SquadRunChip run={{ ...run, teamName: undefined }} />)
    expect(screen.getByTestId("squad-run-chip-team x")).toHaveTextContent("label:unknownSquad")
  })

  it("keeps its clicks and keys away from the card that hosts it", () => {
    const onClick = jest.fn()
    const onKeyDown = jest.fn()
    const onPointerDown = jest.fn()
    render(
      <div onClick={onClick} onKeyDown={onKeyDown} onPointerDown={onPointerDown}>
        <SquadRunChip run={run} />
      </div>
    )
    const chip = screen.getByTestId("squad-run-chip-team x")
    fireEvent.click(chip)
    fireEvent.keyDown(chip, { key: " " })
    fireEvent.pointerDown(chip)
    expect(onClick).not.toHaveBeenCalled()
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(onPointerDown).not.toHaveBeenCalled()
  })

  it("renders a plain span for the drag overlay clone", () => {
    render(<SquadRunChip run={run} inert />)
    const chip = screen.getByTestId("squad-run-chip-team x")
    expect(chip.tagName).toBe("SPAN")
    expect(chip).not.toHaveAttribute("href")
  })
})
