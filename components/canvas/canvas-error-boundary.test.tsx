"use client"

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { CanvasErrorBoundary } from "./canvas-error-boundary"

// Bypass TooltipProvider context (production wraps the app at layout.tsx).
jest.mock("@/components/ui/tooltip")

const messages = {
  canvas: {
    errorTitle: "Something went wrong",
    errorDescription: "An error occurred in the canvas",
    tryAgain: "Try Again",
    copyError: "Copy Error",
    copied: "Copied",
    showDetails: "Show Details",
    hideDetails: "Hide Details",
  },
}

const renderWithProviders = (ui: React.ReactElement) => {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const ThrowError = ({ shouldThrow }: { shouldThrow: boolean }) => {
  if (shouldThrow) {
    throw Object.assign(new Error("Test error"), {
      stack: [
        "Error: Test error",
        "    at CanvasSurface (components/canvas/surface.tsx:42:7)",
        "    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:1:1)",
      ].join("\n"),
    })
  }
  return <div>No error</div>
}

describe("CanvasErrorBoundary", () => {
  const originalConsoleError = console.error

  beforeEach(() => {
    jest.clearAllMocks()
    console.error = jest.fn()
  })

  afterEach(() => {
    console.error = originalConsoleError
  })

  it("renders children when no error", () => {
    renderWithProviders(
      <CanvasErrorBoundary>
        <div>Child content</div>
      </CanvasErrorBoundary>
    )
    expect(screen.getByText("Child content")).toBeInTheDocument()
  })

  it("renders error UI when error occurs", () => {
    renderWithProviders(
      <CanvasErrorBoundary>
        <ThrowError shouldThrow={true} />
      </CanvasErrorBoundary>
    )
    // The boundary's own AlertTitle plus the nested ErrorTraceDetails both
    // render "Something went wrong" — assert at least one is present.
    expect(screen.getAllByText("Something went wrong").length).toBeGreaterThan(0)
  })

  it("fills the available canvas pane when rendering the error UI", () => {
    renderWithProviders(
      <CanvasErrorBoundary>
        <ThrowError shouldThrow={true} />
      </CanvasErrorBoundary>
    )

    const fallback = screen.getAllByText("Something went wrong")[0]?.closest(".bg-background")
    expect(fallback).toHaveClass("w-full", "min-w-0", "flex-1")
  })

  it("renders custom fallback when provided", () => {
    renderWithProviders(
      <CanvasErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowError shouldThrow={true} />
      </CanvasErrorBoundary>
    )
    expect(screen.getByText("Custom fallback")).toBeInTheDocument()
  })

  it("calls onError callback when error occurs", () => {
    const onError = jest.fn()
    renderWithProviders(
      <CanvasErrorBoundary onError={onError}>
        <ThrowError shouldThrow={true} />
      </CanvasErrorBoundary>
    )
    expect(onError).toHaveBeenCalled()
  })

  it("renders try again button", () => {
    renderWithProviders(
      <CanvasErrorBoundary>
        <ThrowError shouldThrow={true} />
      </CanvasErrorBoundary>
    )
    expect(screen.getByRole("button", { name: /Try Again/i })).toBeInTheDocument()
  })

  it("renders the show-stack-trace toggle inside ErrorTraceDetails", () => {
    renderWithProviders(
      <CanvasErrorBoundary>
        <ThrowError shouldThrow={true} />
      </CanvasErrorBoundary>
    )
    // The first-party wrapper exposes the official StackTrace trigger.
    expect(screen.getByRole("button", { name: /Show stack trace/i })).toBeInTheDocument()
  })

  it("renders stack trace summary", () => {
    renderWithProviders(
      <CanvasErrorBoundary>
        <ThrowError shouldThrow={true} />
      </CanvasErrorBoundary>
    )
    expect(screen.getAllByText("Test error")).toHaveLength(2)
  })

  it("reveals raw stack details when the toggle is expanded", async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <CanvasErrorBoundary>
        <ThrowError shouldThrow={true} />
      </CanvasErrorBoundary>
    )

    // Stack contents live inside a Collapsible that defaults to closed.
    expect(
      screen.queryByRole("button", { name: /components\/canvas\/surface\.tsx/ })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Show stack trace/i }))

    expect(
      screen.getByRole("button", { name: /components\/canvas\/surface\.tsx/ })
    ).toBeInTheDocument()
  })

  it("calls onReset when try again clicked", () => {
    const onReset = jest.fn()
    renderWithProviders(
      <CanvasErrorBoundary onReset={onReset}>
        <ThrowError shouldThrow={true} />
      </CanvasErrorBoundary>
    )
    fireEvent.click(screen.getByRole("button", { name: /Try Again/i }))
    expect(onReset).toHaveBeenCalled()
  })
})
