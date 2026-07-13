/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

const errorMock = jest.fn()
jest.mock("@cognia/logging", () => {
  const stub = () => jest.fn()
  return {
    loggers: {
      scheduler: { error: (...a: unknown[]) => errorMock(...a), debug: stub(), fatal: stub() },
      app: { error: stub(), debug: stub(), fatal: stub() },
      ui: { error: stub(), debug: stub(), fatal: stub() },
      native: { error: stub(), debug: stub(), fatal: stub() },
    },
  }
})

jest.mock("@/lib/logging/crash-log", () => ({
  exportCrashLogBundleNow: jest.fn(),
}))

import SchedulerError from "./error"

beforeEach(() => {
  errorMock.mockClear()
})

describe("SchedulerError", () => {
  it("renders the localized title + description from the scheduler namespace and delegates to ErrorPage", () => {
    const reset = jest.fn()
    const err = Object.assign(new Error("boom"), { stack: "Error: boom\n  at fn" })
    render(<SchedulerError error={err} reset={reset} />)

    expect(screen.getByText("errorTitle")).toBeInTheDocument()
    expect(screen.getByText("errorDescription")).toBeInTheDocument()
    expect(screen.getByTestId("error-page")).toHaveAttribute("data-variant", "error")
  })

  it("logs the boundary trip against loggers.scheduler.error with the variant in metadata", () => {
    const reset = jest.fn()
    const err = Object.assign(new Error("boom"), { digest: "abc", stack: "Error: boom" })
    render(<SchedulerError error={err} reset={reset} />)

    expect(errorMock).toHaveBeenCalledWith(
      "Route boundary tripped",
      err,
      expect.objectContaining({ variant: "error", digest: "abc" })
    )
  })

  it("retry button is wired to the reset callback supplied by Next's error boundary", () => {
    const reset = jest.fn()
    render(<SchedulerError error={new Error("boom")} reset={reset} />)
    fireEvent.click(screen.getByTestId("error-page-retry"))
    expect(reset).toHaveBeenCalledTimes(1)
  })
})
