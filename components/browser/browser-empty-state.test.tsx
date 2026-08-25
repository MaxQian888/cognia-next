/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { BrowserEmptyState, QUICK_OPEN_URLS } from "./browser-empty-state"

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
