import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  ErrorReportActions,
  buildErrorReportMarkdown,
  buildIssueUrl,
  type ErrorReportContext,
} from "./error-report-actions"
import { resetRecentErrorLogsForTest } from "@/lib/logging/recent-errors"
import type { StructuredLogEntry } from "@/types/logging"

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))
import { toast } from "sonner"
const toastSuccess = (toast as unknown as { success: jest.Mock }).success
const toastError = (toast as unknown as { error: jest.Mock }).error

const copy = {
  copyReport: "Copy report",
  copyReportSuccess: "Report copied",
  copyReportFailed: "Copy failed",
  reportIssue: "Report issue",
}

const context: ErrorReportContext = { category: "render", locale: "en", pathname: "/x" }

function setup(overrides?: Partial<React.ComponentProps<typeof ErrorReportActions>>) {
  const writeClipboard = jest.fn().mockResolvedValue(undefined)
  const openUrl = jest.fn()
  const getDiagnostics = jest.fn().mockResolvedValue({ isTauri: false, appVersion: "1.0.0" })
  const getRecentErrors = jest.fn().mockReturnValue([])
  render(
    <ErrorReportActions
      error={Object.assign(new Error("boom"), { digest: "d1" })}
      copy={copy}
      context={context}
      toastsEnabled
      writeClipboard={writeClipboard}
      openUrl={openUrl}
      getDiagnostics={getDiagnostics}
      getRecentErrors={getRecentErrors}
      {...overrides}
    />
  )
  return { writeClipboard, openUrl, getDiagnostics, getRecentErrors }
}

beforeEach(() => {
  resetRecentErrorLogsForTest()
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe("ErrorReportActions component", () => {
  it("copies a report and toasts success", async () => {
    const { writeClipboard } = setup()
    await userEvent.click(screen.getByTestId("error-page-copy-report"))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(1))
    expect(writeClipboard.mock.calls[0][0]).toContain("Cognia error report")
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it("flips the copy button to an inline confirmation tick after a successful copy", async () => {
    const { writeClipboard } = setup()
    const button = screen.getByTestId("error-page-copy-report")
    expect(button.querySelector(".lucide-check")).toBeNull()
    await userEvent.click(button)
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(button.querySelector(".lucide-check")).not.toBeNull())
  })

  it("toasts failure when the clipboard write rejects", async () => {
    setup({ writeClipboard: jest.fn().mockRejectedValue(new Error("denied")) })
    await userEvent.click(screen.getByTestId("error-page-copy-report"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("suppresses toasts when toastsEnabled is false", async () => {
    setup({ toastsEnabled: false })
    await userEvent.click(screen.getByTestId("error-page-copy-report"))
    await waitFor(() => expect(toastSuccess).not.toHaveBeenCalled())
  })

  it("hides the report-issue button when no URL is configured", () => {
    setup({ issueReportUrl: undefined })
    expect(screen.queryByTestId("error-page-report-issue")).toBeNull()
  })

  it("uses the default clipboard and window.open when no seams are injected", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    const openSpy = jest.spyOn(window, "open").mockImplementation(() => null)
    render(
      <ErrorReportActions
        error={Object.assign(new Error("boom"), { digest: "d1" })}
        copy={copy}
        context={context}
        toastsEnabled
        issueReportUrl="https://github.com/acme/app"
        getDiagnostics={jest.fn().mockResolvedValue(null)}
        getRecentErrors={jest.fn().mockReturnValue([])}
      />
    )
    await userEvent.click(screen.getByTestId("error-page-copy-report"))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByTestId("error-page-report-issue"))
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1))
    openSpy.mockRestore()
  })

  it("builds a generic issue title when no error object is present", async () => {
    const { openUrl } = setup({ error: null, issueReportUrl: "https://github.com/acme/app" })
    await userEvent.click(screen.getByTestId("error-page-report-issue"))
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1))
    const url = openUrl.mock.calls[0][0] as string
    expect(new URL(url).searchParams.get("title")).toBe("[render] Error report")
  })

  it("shows the report-issue button and opens a prefilled URL when configured", async () => {
    const { openUrl } = setup({ issueReportUrl: "https://github.com/acme/app" })
    await userEvent.click(screen.getByTestId("error-page-report-issue"))
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1))
    const url = openUrl.mock.calls[0][0] as string
    expect(url).toContain("https://github.com/acme/app/issues/new?")
    expect(url).toContain("title=")
    expect(url).toContain("body=")
  })
})

describe("buildIssueUrl", () => {
  it("appends /issues/new when the base is a repo root", () => {
    expect(buildIssueUrl("https://github.com/a/b", "t", "body")).toMatch(
      /^https:\/\/github\.com\/a\/b\/issues\/new\?/
    )
  })

  it("keeps an existing /issues/new endpoint and strips trailing slashes", () => {
    expect(buildIssueUrl("https://github.com/a/b/issues/new/", "t", "x")).toMatch(
      /\/a\/b\/issues\/new\?/
    )
  })

  it("truncates an oversized body", () => {
    const url = buildIssueUrl("https://x.test/r", "t", "Z".repeat(10000))
    const body = new URL(url).searchParams.get("body") ?? ""
    expect(body.length).toBeLessThan(10000)
    expect(body.endsWith("…")).toBe(true)
  })
})

describe("buildErrorReportMarkdown", () => {
  const recent: StructuredLogEntry[] = [
    {
      id: "r1",
      timestamp: "2026-06-23T10:00:00.000Z",
      level: "error",
      message: "earlier",
      module: "app",
    } as StructuredLogEntry,
  ]

  it("includes error, diagnostics, and recent sections", () => {
    const md = buildErrorReportMarkdown({
      error: Object.assign(new Error("boom"), { digest: "abc", stack: "stack-trace" }),
      context,
      recent,
      diagnostics: { isTauri: false, appVersion: "1.0.0" },
      generatedAt: "2026-06-23T10:00:01.000Z",
    })
    expect(md).toContain("Error ID: abc")
    expect(md).toContain("boom")
    expect(md).toContain("stack-trace")
    expect(md).toContain("appVersion")
    expect(md).toContain("Recent errors (1)")
    expect(md).toContain("earlier")
  })

  it("degrades gracefully with no error and no diagnostics", () => {
    const md = buildErrorReportMarkdown({
      error: null,
      context,
      recent: [],
      diagnostics: null,
      generatedAt: "2026-06-23T10:00:01.000Z",
    })
    expect(md).toContain("No error object was provided")
    expect(md).toContain("Diagnostics unavailable")
    expect(md).toContain("Recent errors (0)")
    expect(md).toContain("None recorded")
  })
})
