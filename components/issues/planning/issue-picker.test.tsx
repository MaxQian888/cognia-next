/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { IssuePicker, type IssuePickerCandidate } from "./issue-picker"

const candidates: IssuePickerCandidate[] = [
  { id: "a", identifier: "MERC-1", title: "Alpha", status: "todo" },
  { id: "b", identifier: "MERC-2", title: "Beta", status: "done", disabled: true },
]

describe("IssuePicker", () => {
  it("opens on the trigger and lists every candidate, refused ones disabled", () => {
    render(
      <IssuePicker candidates={candidates} onPick={jest.fn()} triggerLabel="Add" testId="pick" />
    )
    fireEvent.click(screen.getByTestId("pick-trigger"))
    expect(screen.getByTestId("pick-option-a")).toBeInTheDocument()
    expect(screen.getByTestId("pick-option-b")).toHaveAttribute("aria-disabled", "true")
  })

  it("hands back the local id and closes", () => {
    const onPick = jest.fn()
    render(<IssuePicker candidates={candidates} onPick={onPick} triggerLabel="Add" testId="pick" />)
    fireEvent.click(screen.getByTestId("pick-trigger"))
    fireEvent.click(screen.getByTestId("pick-option-a"))
    expect(onPick).toHaveBeenCalledWith("a")
    expect(screen.queryByTestId("pick-option-a")).toBeNull()
  })

  it("ticks the current value", () => {
    render(
      <IssuePicker
        candidates={candidates}
        value="a"
        onPick={jest.fn()}
        triggerLabel="Add"
        testId="pick"
      />
    )
    fireEvent.click(screen.getByTestId("pick-trigger"))
    expect(screen.getByTestId("pick-option-a").querySelector("svg.lucide-check")).not.toBeNull()
  })

  it("accepts a custom trigger", () => {
    render(
      <IssuePicker candidates={candidates} onPick={jest.fn()} triggerLabel="Add" testId="pick">
        <button type="button" data-testid="custom">
          open
        </button>
      </IssuePicker>
    )
    expect(screen.queryByTestId("pick-trigger")).toBeNull()
    fireEvent.click(screen.getByTestId("custom"))
    expect(screen.getByTestId("pick-option-a")).toBeInTheDocument()
  })
})
