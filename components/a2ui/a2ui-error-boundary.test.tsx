/**
 * Tests for A2UIErrorBoundary
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { A2UIErrorBoundary } from "./a2ui-error-boundary"

const mockUiError = jest.fn()

jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: {
      error: (...args: unknown[]) => mockUiError(...args),
    },
  },
}))

const ThrowOnRender = ({ shouldThrow }: { shouldThrow: boolean }) => {
  if (shouldThrow) {
    throw new Error("component exploded")
  }
  return <div>Healthy child</div>
}

describe("A2UIErrorBoundary", () => {
  const originalConsoleError = console.error

  beforeEach(() => {
    jest.clearAllMocks()
    console.error = jest.fn()
  })

  afterEach(() => {
    console.error = originalConsoleError
  })

  it("renders children when there is no error", () => {
    render(
      <A2UIErrorBoundary componentType="text" componentId="cmp-1">
        <ThrowOnRender shouldThrow={false} />
      </A2UIErrorBoundary>
    )

    expect(screen.getByText("Healthy child")).toBeInTheDocument()
  })

  it("renders fallback UI and logs error when child throws", () => {
    render(
      <A2UIErrorBoundary componentType="widget" componentId="w-1">
        <ThrowOnRender shouldThrow={true} />
      </A2UIErrorBoundary>
    )

    expect(screen.getByText("widget render error")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    expect(mockUiError).toHaveBeenCalledWith(
      expect.stringContaining("widget#w-1"),
      expect.any(Error),
      expect.any(Object)
    )
  })

  it("recovers after retry when child no longer throws", () => {
    let allowRender = false
    const ControlledComponent = () => {
      if (!allowRender) {
        throw new Error("first render failed")
      }
      return <div>Recovered child</div>
    }

    render(
      <A2UIErrorBoundary componentType="flaky" componentId="cmp-retry">
        <ControlledComponent />
      </A2UIErrorBoundary>
    )

    const retryButton = screen.getByRole("button", { name: "Retry" })
    allowRender = true
    fireEvent.click(retryButton)

    expect(screen.getByText("Recovered child")).toBeInTheDocument()
  })
})
