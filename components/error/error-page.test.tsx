import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ErrorPage } from "./error-page"

jest.mock("@/lib/logging/crash-log", () => ({
  exportCrashLogBundleNow: jest.fn(),
}))

jest.mock("@/lib/logging", () => {
  const fakeLogger = () => ({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  })
  return {
    loggers: {
      app: fakeLogger(),
      ui: fakeLogger(),
      scheduler: fakeLogger(),
      native: fakeLogger(),
    },
  }
})

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

import { exportCrashLogBundleNow } from "@/lib/logging/crash-log"
import { loggers } from "@/lib/logging"
import { toast } from "sonner"

const exportMock = exportCrashLogBundleNow as jest.MockedFunction<typeof exportCrashLogBundleNow>
const toastSuccess = (toast as unknown as { success: jest.Mock }).success
const toastError = (toast as unknown as { error: jest.Mock }).error

const appLogger = (loggers as unknown as { app: ReturnType<() => Record<string, jest.Mock>> }).app
const uiLogger = (loggers as unknown as { ui: ReturnType<() => Record<string, jest.Mock>> }).ui
const schedulerLogger = (
  loggers as unknown as {
    scheduler: ReturnType<() => Record<string, jest.Mock>>
  }
).scheduler

beforeEach(() => {
  exportMock.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  Object.values(appLogger).forEach((m) => m.mockReset())
  Object.values(uiLogger).forEach((m) => m.mockReset())
  Object.values(schedulerLogger).forEach((m) => m.mockReset())
})

describe("ErrorPage — variant: error", () => {
  it("renders the localized title, description, retry, home, export, and open-logs actions", () => {
    const reset = jest.fn()
    render(<ErrorPage variant="error" error={new Error("boom")} reset={reset} />)

    expect(screen.getByTestId("error-page")).toHaveAttribute("data-variant", "error")
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
    expect(screen.getByTestId("error-page-retry")).toBeInTheDocument()
    expect(screen.getByTestId("error-page-home")).toBeInTheDocument()
    expect(screen.getByTestId("error-page-export")).toBeInTheDocument()
    expect(screen.getByTestId("error-page-open-logs")).toBeInTheDocument()
  })

  it("clicking retry calls the reset callback", async () => {
    const reset = jest.fn()
    render(<ErrorPage variant="error" error={new Error("boom")} reset={reset} />)
    await userEvent.click(screen.getByTestId("error-page-retry"))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it("home button links to the supplied homeHref (defaults to /)", () => {
    const { unmount } = render(
      <ErrorPage variant="error" error={new Error("boom")} reset={() => {}} />
    )
    expect(screen.getByTestId("error-page-home")).toHaveAttribute("href", "/")
    unmount()

    render(
      <ErrorPage variant="error" error={new Error("boom")} reset={() => {}} homeHref="/dashboard" />
    )
    expect(screen.getByTestId("error-page-home")).toHaveAttribute("href", "/dashboard")
  })

  it("renders the digest as a copyable Error ID badge", async () => {
    const error = Object.assign(new Error("boom"), { digest: "deadbeef" })
    render(<ErrorPage variant="error" error={error} reset={() => {}} />)
    expect(screen.getByTestId("error-page-id")).toHaveTextContent("deadbeef")

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    })
    await userEvent.click(screen.getByTestId("error-page-copy-id"))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("deadbeef")
  })

  it("export button delegates to exportCrashLogBundleNow with the error + subsystem", async () => {
    const error = Object.assign(new Error("boom"), { digest: "abc" })
    render(<ErrorPage variant="error" error={error} reset={() => {}} subsystem="scheduler" />)
    exportMock.mockResolvedValue(undefined)
    await userEvent.click(screen.getByTestId("error-page-export"))
    expect(exportMock).toHaveBeenCalledWith({
      triggerError: error,
      subsystem: "scheduler",
    })
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it("surfaces a failure toast when the crash export rejects", async () => {
    exportMock.mockRejectedValue(new Error("disk full"))
    render(<ErrorPage variant="error" error={new Error("boom")} reset={() => {}} />)
    await userEvent.click(screen.getByTestId("error-page-export"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(appLogger.error).toHaveBeenCalledWith("Crash log export failed", expect.any(Error))
  })

  it("logs at error level via loggers.app by default on mount", () => {
    render(<ErrorPage variant="error" error={new Error("boom")} reset={() => {}} />)
    expect(appLogger.error).toHaveBeenCalledWith(
      "Route boundary tripped",
      expect.any(Error),
      expect.objectContaining({ variant: "error" })
    )
  })

  it("respects the subsystem prop when selecting the logger", () => {
    render(
      <ErrorPage variant="error" error={new Error("boom")} reset={() => {}} subsystem="scheduler" />
    )
    expect(schedulerLogger.error).toHaveBeenCalled()
    expect(appLogger.error).not.toHaveBeenCalled()
  })

  it("disableRetry / disableHome / disableCrashExport hide the matching buttons", () => {
    render(
      <ErrorPage
        variant="error"
        error={new Error("boom")}
        reset={() => {}}
        disableRetry
        disableHome
        disableCrashExport
      />
    )
    expect(screen.queryByTestId("error-page-retry")).toBeNull()
    expect(screen.queryByTestId("error-page-home")).toBeNull()
    expect(screen.queryByTestId("error-page-export")).toBeNull()
  })

  it("title / description props override the default i18n copy", () => {
    render(
      <ErrorPage
        variant="error"
        error={new Error("boom")}
        reset={() => {}}
        title="Custom title"
        description="Custom description"
      />
    )
    expect(screen.getByText("Custom title")).toBeInTheDocument()
    expect(screen.getByText("Custom description")).toBeInTheDocument()
  })

  it("additionalActions are rendered alongside the default buttons", () => {
    render(
      <ErrorPage
        variant="error"
        error={new Error("boom")}
        reset={() => {}}
        additionalActions={<button data-testid="extra-action">Custom</button>}
      />
    )
    expect(screen.getByTestId("extra-action")).toBeInTheDocument()
  })
})

describe("ErrorPage — variant: not-found", () => {
  it("renders 404 copy, hides retry / export / trace, keeps home + open-logs", () => {
    render(<ErrorPage variant="not-found" />)
    expect(screen.getByTestId("error-page")).toHaveAttribute("data-variant", "not-found")
    expect(screen.getByText("Page not found")).toBeInTheDocument()
    expect(screen.queryByTestId("error-page-retry")).toBeNull()
    expect(screen.queryByTestId("error-page-export")).toBeNull()
    expect(screen.getByTestId("error-page-home")).toBeInTheDocument()
    expect(screen.getByTestId("error-page-open-logs")).toBeInTheDocument()
  })

  it("logs at debug level via loggers.ui (default subsystem for not-found)", () => {
    render(<ErrorPage variant="not-found" />)
    expect(uiLogger.debug).toHaveBeenCalledWith("Route not found", expect.any(Object))
    expect(uiLogger.error).not.toHaveBeenCalled()
  })
})

describe("ErrorPage — variant: global-error with staticLocale='en'", () => {
  it("renders without calling useTranslations or usePathname (provider-free)", () => {
    render(
      <ErrorPage
        variant="global-error"
        error={new Error("layout crashed")}
        reset={() => {}}
        staticLocale="en"
      />
    )
    expect(screen.getByText("Cognia stopped working")).toBeInTheDocument()
    expect(screen.getByTestId("error-page-retry")).toBeInTheDocument()
    expect(screen.getByTestId("error-page-home")).toBeInTheDocument()
    expect(screen.getByTestId("error-page-export")).toBeInTheDocument()
  })

  it("logs at fatal level via loggers.app", () => {
    render(
      <ErrorPage
        variant="global-error"
        error={new Error("layout crashed")}
        reset={() => {}}
        staticLocale="en"
      />
    )
    expect(appLogger.fatal).toHaveBeenCalledWith(
      "Route boundary tripped",
      expect.any(Error),
      expect.objectContaining({ variant: "global-error" })
    )
  })

  it("suppresses sonner toasts in static mode", async () => {
    exportMock.mockResolvedValue(undefined)
    render(
      <ErrorPage
        variant="global-error"
        error={new Error("layout crashed")}
        reset={() => {}}
        staticLocale="en"
      />
    )
    await userEvent.click(screen.getByTestId("error-page-export"))
    await waitFor(() => expect(exportMock).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe("ErrorPage — exportCrashLogImpl seam", () => {
  it("uses the injected impl in place of the default helper", async () => {
    const stub = jest.fn().mockResolvedValue(undefined)
    render(
      <ErrorPage
        variant="error"
        error={new Error("boom")}
        reset={() => {}}
        exportCrashLogImpl={stub}
      />
    )
    await userEvent.click(screen.getByTestId("error-page-export"))
    expect(stub).toHaveBeenCalledTimes(1)
    expect(exportMock).not.toHaveBeenCalled()
  })
})
