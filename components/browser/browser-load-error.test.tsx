import { fireEvent, render, screen } from "@testing-library/react"

import { BrowserLoadError } from "./browser-load-error"

it("shows the failed address and exposes page recovery actions", () => {
  const onRetry = jest.fn()
  const onEditAddress = jest.fn()
  const onOpenExternal = jest.fn()
  render(
    <BrowserLoadError
      url="http://localhost:9999/"
      onRetry={onRetry}
      onEditAddress={onEditAddress}
      onOpenExternal={onOpenExternal}
    />
  )
  expect(screen.getByRole("alert")).toHaveTextContent("http://localhost:9999/")
  expect(screen.getByRole("heading")).toHaveTextContent("This page could not be opened")
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  fireEvent.click(screen.getByRole("button", { name: "Edit address" }))
  fireEvent.click(screen.getByRole("button", { name: "Open in external browser" }))
  expect(onRetry).toHaveBeenCalledTimes(1)
  expect(onEditAddress).toHaveBeenCalledTimes(1)
  expect(onOpenExternal).toHaveBeenCalledTimes(1)
})

it("distinguishes an unconfirmed load from a confirmed failure", () => {
  const onContinue = jest.fn()
  render(
    <BrowserLoadError
      url="https://example.com"
      timedOut
      onRetry={jest.fn()}
      onContinue={onContinue}
    />
  )
  expect(screen.getByRole("heading")).toHaveTextContent("This page is taking too long to load")
  fireEvent.click(screen.getByRole("button", { name: "Show page anyway" }))
  expect(onContinue).toHaveBeenCalledTimes(1)
})
