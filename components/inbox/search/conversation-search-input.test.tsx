/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { ConversationSearchInput } from "./conversation-search-input"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("ConversationSearchInput", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("renders the search affordance with placeholder + aria", () => {
    wrap(<ConversationSearchInput value="" onDebouncedChange={jest.fn()} />)
    const input = screen.getByTestId("conversation-search-input")
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute("placeholder")
    expect(input).toHaveAccessibleName(/search conversations/i)
  })

  it("debounces typing before calling onDebouncedChange", () => {
    const onChange = jest.fn()
    wrap(<ConversationSearchInput value="" onDebouncedChange={onChange} debounceMs={200} />)
    const input = screen.getByTestId("conversation-search-input")
    fireEvent.change(input, { target: { value: "h" } })
    fireEvent.change(input, { target: { value: "he" } })
    fireEvent.change(input, { target: { value: "hello" } })
    expect(onChange).not.toHaveBeenCalled()
    act(() => {
      jest.advanceTimersByTime(200)
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith("hello")
  })

  it("clear button resets text + commits empty value immediately", () => {
    const onChange = jest.fn()
    wrap(<ConversationSearchInput value="alpha" onDebouncedChange={onChange} />)
    const clearBtn = screen.getByTestId("conversation-search-clear")
    fireEvent.click(clearBtn)
    expect(onChange).toHaveBeenCalledWith("")
  })

  it("Esc keypress clears when the field has content", () => {
    const onChange = jest.fn()
    wrap(<ConversationSearchInput value="alpha" onDebouncedChange={onChange} />)
    const input = screen.getByTestId("conversation-search-input")
    fireEvent.keyDown(input, { key: "Escape" })
    expect(onChange).toHaveBeenCalledWith("")
  })

  it("syncs internal text when controlled value resets externally", () => {
    const { rerender } = wrap(
      <NextIntlClientProvider
        locale="en"
        messages={enMessages as unknown as Record<string, unknown>}
      >
        <ConversationSearchInput value="initial" onDebouncedChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId<HTMLInputElement>("conversation-search-input").value).toBe("initial")
    rerender(
      <NextIntlClientProvider
        locale="en"
        messages={enMessages as unknown as Record<string, unknown>}
      >
        <ConversationSearchInput value="" onDebouncedChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId<HTMLInputElement>("conversation-search-input").value).toBe("")
  })
})
