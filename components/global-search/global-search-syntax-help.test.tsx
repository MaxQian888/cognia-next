/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GLOBAL_SEARCH_SYNTAX_KEYS, GlobalSearchSyntaxHelp } from "./global-search-syntax-help"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function renderWithInput() {
  return render(
    <div>
      <input data-testid="search-input" />
      <GlobalSearchSyntaxHelp />
    </div>
  )
}

describe("GlobalSearchSyntaxHelp", () => {
  it("is a labelled icon button that starts closed", () => {
    renderWithInput()
    const trigger = screen.getByRole("button", { name: "footer.syntax" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("global-search-syntax-help-content")).toBeNull()
  })

  it("does not take focus from the search input on press", () => {
    renderWithInput()
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
    fireEvent(screen.getByTestId("global-search-syntax-help"), pointerDown)
    expect(pointerDown.defaultPrevented).toBe(true)
  })

  // A tooltip never opens on a tap; a popover opens on click and tap alike.
  it("opens the cheat sheet on click, every line in order, keeping input focus", async () => {
    renderWithInput()
    const input = screen.getByTestId("search-input")
    input.focus()
    await userEvent.click(screen.getByTestId("global-search-syntax-help"))
    const content = await screen.findByTestId("global-search-syntax-help-content")
    expect(within(content).getByText("footer.syntax")).toBeInTheDocument()
    const lines = within(content)
      .getAllByRole("listitem")
      .map((li) => li.textContent)
    expect(lines).toEqual(GLOBAL_SEARCH_SYNTAX_KEYS.map((key) => `syntax.${key}`))
    expect(input).toHaveFocus()
    expect(screen.getByTestId("global-search-syntax-help")).toHaveAttribute("aria-expanded", "true")
  })

  it("toggles closed on a second press", async () => {
    renderWithInput()
    const trigger = screen.getByTestId("global-search-syntax-help")
    await userEvent.click(trigger)
    expect(await screen.findByTestId("global-search-syntax-help-content")).toBeInTheDocument()
    await userEvent.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })
})
