/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useUrlSearchDraft } from "./use-url-search-draft"

function Box({ query, setQuery }: { query: string; setQuery: (value: string) => void }) {
  const props = useUrlSearchDraft(query, setQuery)
  return <input aria-label="search" {...props} />
}

describe("useUrlSearchDraft", () => {
  // The URL lags a keystroke behind; this one never catches up at all.
  it("keeps what is typed while the URL catches up", async () => {
    const setQuery = jest.fn()
    render(<Box query="" setQuery={setQuery} />)
    const box = screen.getByRole("textbox", { name: "search" })
    await userEvent.type(box, "ab")
    expect(box).toHaveValue("ab")
    expect(setQuery).toHaveBeenNthCalledWith(1, "a")
    expect(setQuery).toHaveBeenLastCalledWith("ab")
  })

  it("writes nothing until an IME composition ends, then the final text once", () => {
    const setQuery = jest.fn()
    render(<Box query="" setQuery={setQuery} />)
    const box = screen.getByRole("textbox", { name: "search" })
    fireEvent.compositionStart(box)
    fireEvent.input(box, { target: { value: "ni" }, isComposing: true })
    expect(box).toHaveValue("ni")
    expect(setQuery).not.toHaveBeenCalled()
    fireEvent.input(box, { target: { value: "你" }, isComposing: true })
    fireEvent.compositionEnd(box)
    expect(setQuery).toHaveBeenCalledTimes(1)
    expect(setQuery).toHaveBeenCalledWith("你")
  })

  it("follows a query the URL gets from elsewhere", () => {
    const { rerender } = render(<Box query="" setQuery={jest.fn()} />)
    rerender(<Box query="alpha" setQuery={jest.fn()} />)
    expect(screen.getByRole("textbox", { name: "search" })).toHaveValue("alpha")
    rerender(<Box query="" setQuery={jest.fn()} />)
    expect(screen.getByRole("textbox", { name: "search" })).toHaveValue("")
  })

  // While the box has focus every URL change is the box's own, possibly a
  // stale one; adopting it would throw away what was typed since.
  it("ignores a lagging URL while the box has focus", async () => {
    const { rerender } = render(<Box query="" setQuery={jest.fn()} />)
    const box = screen.getByRole("textbox", { name: "search" })
    await userEvent.type(box, "ab")
    rerender(<Box query="a" setQuery={jest.fn()} />)
    expect(box).toHaveValue("ab")
  })
})
