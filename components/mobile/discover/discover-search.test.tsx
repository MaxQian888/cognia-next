/**
 * @jest-environment jsdom
 */
import { createRef } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DiscoverSearch } from "./discover-search"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      search: "Search…",
      searchAria: "Search aria",
    }
    return map[key] ?? key
  },
}))

describe("<DiscoverSearch />", () => {
  it("renders the placeholder and aria label", () => {
    render(<DiscoverSearch value="" onChange={jest.fn()} />)
    const input = screen.getByTestId("discover-search-input")
    expect(input).toHaveAttribute("placeholder", "Search…")
    expect(input).toHaveAttribute("aria-label", "Search aria")
  })

  it("calls onChange as the user types", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(<DiscoverSearch value="" onChange={onChange} />)
    await user.type(screen.getByTestId("discover-search-input"), "ab")
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith("b")
  })

  it("hides the clear button when empty", () => {
    render(<DiscoverSearch value="" onChange={jest.fn()} />)
    expect(screen.queryByTestId("discover-search-clear")).not.toBeInTheDocument()
  })

  it("clears via the X button", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(<DiscoverSearch value="hello" onChange={onChange} />)
    await user.click(screen.getByTestId("discover-search-clear"))
    expect(onChange).toHaveBeenCalledWith("")
  })

  it("forwards inputRef to the underlying input (for the '/' hotkey)", () => {
    const ref = createRef<HTMLInputElement>()
    render(<DiscoverSearch value="" onChange={jest.fn()} inputRef={ref} />)
    expect(ref.current).toBe(screen.getByTestId("discover-search-input"))
  })
})
