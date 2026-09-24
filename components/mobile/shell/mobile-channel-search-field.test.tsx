/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { MobileChannelSearchField } from "./mobile-channel-search-field"

const onChange = jest.fn()
const onClear = jest.fn()
let value = ""
jest.mock("./mobile-channel-list-source", () => ({
  useMobileChannelSearchField: () => ({ value, onChange, onClear }),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

beforeEach(() => {
  value = ""
  onChange.mockReset()
  onClear.mockReset()
})

describe("<MobileChannelSearchField />", () => {
  it("is a search input, so the coarse-pointer 16px rule applies and iOS does not zoom", () => {
    render(<MobileChannelSearchField />)
    const input = screen.getByTestId("mobile-channel-search")
    expect(input).toHaveAttribute("type", "search")
    expect(input).toHaveAttribute("enterkeyhint", "search")
    expect(input).toHaveAccessibleName("searchAria")
    // No 14px override: below `md` the Input's own `text-base` stands.
    expect(input).not.toHaveClass("text-sm")
  })

  it("reports every keystroke to the source", async () => {
    const user = userEvent.setup()
    render(<MobileChannelSearchField />)
    await user.type(screen.getByTestId("mobile-channel-search"), "a")
    expect(onChange).toHaveBeenCalledWith("a")
  })

  it("reserves room for the clear button only while there is text", () => {
    const { rerender } = render(<MobileChannelSearchField />)
    expect(screen.getByTestId("mobile-channel-search")).toHaveClass("pr-3")
    expect(screen.queryByTestId("mobile-channel-search-clear")).toBeNull()
    value = "octo"
    rerender(<MobileChannelSearchField />)
    expect(screen.getByTestId("mobile-channel-search")).toHaveClass("pr-11")
    const clear = screen.getByTestId("mobile-channel-search-clear")
    // The 44px floor, not the old 24px glyph button.
    expect(clear).toHaveClass("size-11")
    expect(clear).toHaveAccessibleName("clearSearch")
  })

  it("clears from the button and from Escape", async () => {
    value = "octo"
    const user = userEvent.setup()
    render(<MobileChannelSearchField />)
    await user.click(screen.getByTestId("mobile-channel-search-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
    const notCancelled = fireEvent.keyDown(screen.getByTestId("mobile-channel-search"), {
      key: "Escape",
    })
    expect(onClear).toHaveBeenCalledTimes(2)
    expect(notCancelled).toBe(false)
  })

  it("lets Escape through to the drawer once the box is empty", () => {
    render(<MobileChannelSearchField />)
    const notCancelled = fireEvent.keyDown(screen.getByTestId("mobile-channel-search"), {
      key: "Escape",
    })
    expect(onClear).not.toHaveBeenCalled()
    expect(notCancelled).toBe(true)
  })
})
