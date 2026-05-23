/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
import enMessages from "@/i18n/messages/en.json"

jest.mock("@/lib/logging", () => ({
  loggers: { ui: { error: jest.fn() } },
}))

import { InboxErrorBoundary } from "./inbox-error-boundary"
import { loggers } from "@/lib/logging"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      {ui}
    </NextIntlClientProvider>
  )
}

function Bomb({ trigger }: { trigger: boolean }) {
  if (trigger) throw new Error("kaboom")
  return <span data-testid="bomb-ok">ok</span>
}

beforeEach(() => {
  ;(loggers.ui.error as jest.Mock).mockClear()
})

describe("InboxErrorBoundary", () => {
  it("renders children when no error is thrown", () => {
    wrap(
      <InboxErrorBoundary>
        <Bomb trigger={false} />
      </InboxErrorBoundary>
    )
    expect(screen.getByTestId("bomb-ok")).toBeInTheDocument()
  })

  it("catches errors and renders the StateCard.Error fallback", () => {
    // jsdom prints the React error to the console; silence it for the test.
    const originalError = console.error
    console.error = jest.fn()
    try {
      wrap(
        <InboxErrorBoundary>
          <Bomb trigger />
        </InboxErrorBoundary>
      )
      expect(screen.getByTestId("inbox-error-boundary")).toBeInTheDocument()
      expect(screen.getByTestId("state-card-error")).toBeInTheDocument()
      expect(loggers.ui.error).toHaveBeenCalled()
    } finally {
      console.error = originalError
    }
  })

  it("retry resets state and re-renders children when the trigger flips off", () => {
    const originalError = console.error
    console.error = jest.fn()
    try {
      function Wrapper() {
        const [boom, setBoom] = useState(true)
        return (
          <InboxErrorBoundary onReset={() => setBoom(false)}>
            <Bomb trigger={boom} />
          </InboxErrorBoundary>
        )
      }
      wrap(<Wrapper />)
      expect(screen.getByTestId("state-card-error")).toBeInTheDocument()
      fireEvent.click(screen.getByTestId("state-card-error-retry"))
      expect(screen.getByTestId("bomb-ok")).toBeInTheDocument()
    } finally {
      console.error = originalError
    }
  })

  it("uses the custom fallback when provided", () => {
    const originalError = console.error
    console.error = jest.fn()
    try {
      wrap(
        <InboxErrorBoundary fallback={<span data-testid="custom-fallback">custom</span>}>
          <Bomb trigger />
        </InboxErrorBoundary>
      )
      expect(screen.getByTestId("custom-fallback")).toBeInTheDocument()
    } finally {
      console.error = originalError
    }
  })
})
