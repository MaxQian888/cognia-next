/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { BrowserEmptyState, EMPTY_STATE_RECENT_LIMIT, QUICK_OPEN_URLS } from "./browser-empty-state"

it("offers a one-click chip per common dev-server address", () => {
  const onOpen = jest.fn()
  render(<BrowserEmptyState onOpen={onOpen} />)
  expect(screen.getByText("Preview a web page")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "localhost:5173" }))
  expect(onOpen).toHaveBeenCalledWith("http://localhost:5173")
})

it("renders a chip for every quick-open address", () => {
  render(<BrowserEmptyState onOpen={jest.fn()} />)
  for (const url of QUICK_OPEN_URLS) {
    expect(screen.getByRole("button", { name: new URL(url).host })).toBeInTheDocument()
  }
})

describe("recent pages", () => {
  const RECENT = [
    "https://docs.example.com/guide/start",
    "http://localhost:3000/dashboard",
    "https://a.example/",
    "https://b.example/",
    "https://c.example/",
  ]

  it("offers the most recently visited pages first, capped", () => {
    render(<BrowserEmptyState onOpen={jest.fn()} recent={RECENT} />)
    const row = screen.getByTestId("browser-empty-recent")
    expect(row).toHaveTextContent("docs.example.com/guide/start")
    expect(row.querySelectorAll("button")).toHaveLength(EMPTY_STATE_RECENT_LIMIT)
    expect(row).not.toHaveTextContent("c.example")
  })

  it("opens the full address of a recent page", () => {
    const onOpen = jest.fn()
    render(<BrowserEmptyState onOpen={onOpen} recent={RECENT} />)
    fireEvent.click(screen.getByRole("button", { name: "docs.example.com/guide/start" }))
    expect(onOpen).toHaveBeenCalledWith("https://docs.example.com/guide/start")
  })

  it("draws no recent row before anything has been visited", () => {
    render(<BrowserEmptyState onOpen={jest.fn()} />)
    expect(screen.queryByTestId("browser-empty-recent")).toBeNull()
  })
})
