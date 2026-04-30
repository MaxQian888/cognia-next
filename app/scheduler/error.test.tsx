/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const errorMock = jest.fn()
jest.mock("@/lib/logger", () => ({
  loggers: {
    scheduler: {
      error: (...args: unknown[]) => errorMock(...args),
    },
  },
}))

import SchedulerError from "./error"

beforeEach(() => {
  errorMock.mockClear()
})

describe("SchedulerError", () => {
  it("renders the localized title, the stack trace, and a retry button", () => {
    const reset = jest.fn()
    const err = Object.assign(new Error("boom"), { stack: "Error: boom\n  at fn" })
    render(<SchedulerError error={err} reset={reset} />)

    expect(screen.getByText("errorTitle")).toBeInTheDocument()
    expect(screen.getByText("errorDescription")).toBeInTheDocument()
    expect(screen.getByText(/Error: boom/)).toBeInTheDocument()

    expect(errorMock).toHaveBeenCalledWith("Scheduler page error", err)

    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(reset).toHaveBeenCalled()
  })

  it("falls back to name + message when stack is missing", () => {
    const reset = jest.fn()
    const err = new Error("plain")
    err.stack = undefined as unknown as string
    render(<SchedulerError error={err} reset={reset} />)

    // The fallback joins error.name and error.message with ": ".
    expect(screen.getByText(/Error: plain/)).toBeInTheDocument()
  })
})
