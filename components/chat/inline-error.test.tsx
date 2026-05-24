/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { InlineError } from "./inline-error"

describe("InlineError", () => {
  it("renders the error message and the failure title", () => {
    render(<InlineError message="something went wrong" />)
    expect(screen.getByText("Failed to send")).toBeInTheDocument()
    expect(screen.getByText("something went wrong")).toBeInTheDocument()
  })

  it("parses a network error into a category badge with a hint", () => {
    render(<InlineError message="connect ECONNREFUSED 127.0.0.1:5173" />)
    expect(screen.getByText("Connection refused")).toBeInTheDocument()
    expect(screen.getByText(/server isn't accepting connections/i)).toBeInTheDocument()
  })

  it("invokes onRetry when the retry button is clicked", () => {
    const onRetry = jest.fn()
    render(<InlineError message="boom" onRetry={onRetry} />)
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("offers the settings shortcut for api-key failures", () => {
    const onOpenSettings = jest.fn()
    render(
      <InlineError
        message="Invalid API key provided"
        onOpenSettings={onOpenSettings}
        onRetry={() => {}}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it("invokes onDismiss when dismissed", () => {
    const onDismiss = jest.fn()
    render(<InlineError message="boom" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
