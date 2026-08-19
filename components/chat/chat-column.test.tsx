// The chat surface docks a dozen notices (errors, plan docks, the run status
// bar, the support panel) between the transcript and the composer. Every one of
// them has to land on the SAME cap + gutter the transcript and the composer
// use, or it renders as a full-bleed band across a centred conversation. These
// tests pin that contract on the wrapper itself and on the two columns it has
// to match.

import { render, screen } from "@testing-library/react"

import { ChatColumn, chatColumnClass } from "./chat-column"

describe("ChatColumn", () => {
  it("caps and pads exactly like the transcript and composer reading columns", () => {
    // Kept in sync by hand with `message-list.tsx` / `composer.tsx`. The
    // padding lives INSIDE the cap on purpose — see the module docblock.
    expect(chatColumnClass).toBe("mx-auto w-full max-w-[52rem] px-3 sm:px-5")
  })

  it("applies the reading column to its wrapper element", () => {
    render(
      <ChatColumn>
        <span>notice</span>
      </ChatColumn>
    )
    const column = screen.getByText("notice").parentElement
    expect(column).toHaveClass("mx-auto", "w-full", "max-w-[52rem]", "px-3", "sm:px-5")
    expect(column).toHaveAttribute("data-slot", "chat-notice-column")
  })

  it("keeps caller spacing on top of the column classes", () => {
    render(
      <ChatColumn className="mt-2" data-testid="wrapped">
        <span>notice</span>
      </ChatColumn>
    )
    const column = screen.getByTestId("wrapped")
    expect(column).toHaveClass("mt-2", "max-w-[52rem]")
  })

  it("collapses when the docked notice renders nothing", () => {
    // Self-hiding notices (character-missing, work-submission, the plan docks)
    // return null; `empty:hidden` keeps the wrapper's own margin from opening a
    // gap above the composer in that state.
    const { container } = render(<ChatColumn className="mt-2">{null}</ChatColumn>)
    const column = container.firstElementChild
    expect(column).toHaveClass("empty:hidden")
    expect(column?.childNodes).toHaveLength(0)
  })
})
