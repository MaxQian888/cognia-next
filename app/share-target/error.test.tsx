/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

const errorMock = jest.fn()
jest.mock("@/lib/logging", () => {
  const stub = () => jest.fn()
  return {
    loggers: {
      native: { error: (...a: unknown[]) => errorMock(...a), debug: stub(), fatal: stub() },
      app: { error: stub(), debug: stub(), fatal: stub() },
      ui: { error: stub(), debug: stub(), fatal: stub() },
      scheduler: { error: stub(), debug: stub(), fatal: stub() },
    },
  }
})

jest.mock("@/lib/logging/crash-log", () => ({
  exportCrashLogBundleNow: jest.fn(),
}))

import ShareTargetError from "./error"

beforeEach(() => {
  errorMock.mockClear()
})

describe("ShareTargetError", () => {
  it("renders the localized title + description from the share-target namespace and delegates to ErrorPage", () => {
    const reset = jest.fn()
    const err = Object.assign(new Error("boom"), { stack: "Error: boom\n  at fn" })
    render(<ShareTargetError error={err} reset={reset} />)

    expect(screen.getByText("errorTitle")).toBeInTheDocument()
    expect(screen.getByText("errorDescription")).toBeInTheDocument()
    expect(screen.getByTestId("error-page")).toHaveAttribute("data-variant", "error")
  })

  it("logs the boundary trip against loggers.native.error with the variant in metadata", () => {
    const reset = jest.fn()
    const err = Object.assign(new Error("boom"), { digest: "xyz" })
    render(<ShareTargetError error={err} reset={reset} />)

    expect(errorMock).toHaveBeenCalledWith(
      "Route boundary tripped",
      err,
      expect.objectContaining({ variant: "error", digest: "xyz" })
    )
  })

  it("retry button is wired to the reset callback supplied by Next's error boundary", () => {
    const reset = jest.fn()
    render(<ShareTargetError error={new Error("boom")} reset={reset} />)
    fireEvent.click(screen.getByTestId("error-page-retry"))
    expect(reset).toHaveBeenCalledTimes(1)
  })
})
