/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const uiRef = { findOpen: false }
const openFind = jest.fn()
const closeFind = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: unknown) => unknown) =>
    selector({ findOpen: uiRef.findOpen, openFind, closeFind }),
}))

const findRef = {
  query: "",
  matchCount: 0,
  activeIndex: 0,
}
const setQuery = jest.fn()
const next = jest.fn()
const prev = jest.fn()
jest.mock("@/hooks/desktop/use-find-in-page", () => ({
  useFindInPage: () => ({
    query: findRef.query,
    setQuery,
    matchCount: findRef.matchCount,
    activeIndex: findRef.activeIndex,
    next,
    prev,
  }),
}))

import { FindBar } from "./find-bar"

beforeEach(() => {
  uiRef.findOpen = false
  findRef.query = ""
  findRef.matchCount = 0
  findRef.activeIndex = 0
  openFind.mockClear()
  closeFind.mockClear()
  setQuery.mockClear()
  next.mockClear()
  prev.mockClear()
})

describe("FindBar", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<FindBar />)
    expect(container.firstChild).toBeNull()
  })

  it("opens on Ctrl+F even while closed (and suppresses the default)", () => {
    render(<FindBar />)
    const evt = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true })
    fireEvent(window, evt)
    expect(openFind).toHaveBeenCalled()
    expect(evt.defaultPrevented).toBe(true)
  })

  it("opens on Cmd+F", () => {
    render(<FindBar />)
    fireEvent(window, new KeyboardEvent("keydown", { key: "F", metaKey: true, cancelable: true }))
    expect(openFind).toHaveBeenCalled()
  })

  it("renders the input and 'no results' when open with no matches", () => {
    uiRef.findOpen = true
    render(<FindBar />)
    expect(screen.getByTestId("find-input")).toBeInTheDocument()
    expect(screen.getByTestId("find-count")).toHaveTextContent("noMatches")
    expect(screen.getByTestId("find-prev")).toBeDisabled()
    expect(screen.getByTestId("find-next")).toBeDisabled()
  })

  it("shows the match position when there are results", () => {
    uiRef.findOpen = true
    findRef.matchCount = 5
    findRef.activeIndex = 2
    render(<FindBar />)
    expect(screen.getByTestId("find-count")).toHaveTextContent('matchOf:{"index":2,"total":5}')
    expect(screen.getByTestId("find-next")).not.toBeDisabled()
  })

  it("updates the query on typing", () => {
    uiRef.findOpen = true
    render(<FindBar />)
    fireEvent.change(screen.getByTestId("find-input"), { target: { value: "hello" } })
    expect(setQuery).toHaveBeenCalledWith("hello")
  })

  it("navigates with Enter / Shift+Enter and closes on Escape", () => {
    uiRef.findOpen = true
    findRef.matchCount = 3
    render(<FindBar />)
    const input = screen.getByTestId("find-input")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(next).toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(prev).toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Escape" })
    expect(closeFind).toHaveBeenCalled()
  })

  it("wires the prev / next / close buttons", () => {
    uiRef.findOpen = true
    findRef.matchCount = 3
    render(<FindBar />)
    fireEvent.click(screen.getByTestId("find-prev"))
    expect(prev).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("find-next"))
    expect(next).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("find-close"))
    expect(closeFind).toHaveBeenCalled()
  })
})
