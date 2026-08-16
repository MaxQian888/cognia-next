import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ISSUES_URL } from "@/lib/constants/external-urls"
import type { SupportReport } from "@/lib/support-report/types"

import { ErrorReportActions, type ErrorReportContext } from "./error-report-actions"

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
  reportIssueFailed: "Tracker failed",
}

const context: ErrorReportContext = { category: "render", locale: "en", pathname: "/x" }

const report: SupportReport = {
  title: "[render] boom",
  markdown: "## Cognia support report\nboom",
  filename: "cognia-support-report-2026-08-16.md",
  generatedAt: "2026-08-16T00:00:00.000Z",
  sectionIds: ["error"],
}

function setup(overrides?: Partial<React.ComponentProps<typeof ErrorReportActions>>) {
  const writeClipboard = jest.fn().mockResolvedValue(undefined)
  const openExternal = jest.fn().mockResolvedValue(undefined)
  const build = jest.fn().mockResolvedValue(report)
  render(
    <ErrorReportActions
      error={Object.assign(new Error("boom"), { digest: "d1", stack: "at foo" })}
      copy={copy}
      context={context}
      toastsEnabled
      channelDeps={{ writeClipboard, openExternal }}
      build={build}
      {...overrides}
    />
  )
  return { writeClipboard, openExternal, build }
}

beforeEach(() => {
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe("ErrorReportActions component", () => {
  it("builds the report from the error-page context and copies it", async () => {
    const { writeClipboard, build } = setup()
    await userEvent.click(screen.getByTestId("error-page-copy-report"))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(report.markdown))
    expect(build).toHaveBeenCalledWith({
      context: {
        surface: "error-page",
        category: "render",
        locale: "en",
        route: "/x",
        error: { name: "Error", message: "boom", stack: "at foo", digest: "d1" },
      },
    })
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Report copied"))
  })

  it("passes a null error through and omits absent stack / digest", async () => {
    const { build } = setup({ error: null })
    await userEvent.click(screen.getByTestId("error-page-copy-report"))
    await waitFor(() => expect(build).toHaveBeenCalled())
    expect(build.mock.calls[0][0].context.error).toBeNull()

    const bare = new Error("bare")
    bare.stack = undefined
    const second = setup({ error: bare })
    await userEvent.click(screen.getAllByTestId("error-page-copy-report")[1])
    await waitFor(() => expect(second.build).toHaveBeenCalled())
    expect(second.build.mock.calls[0][0].context.error).toEqual({ name: "Error", message: "bare" })
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
    setup({ channelDeps: { writeClipboard: jest.fn().mockRejectedValue(new Error("denied")) } })
    await userEvent.click(screen.getByTestId("error-page-copy-report"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Copy failed"))
  })

  it("suppresses toasts when toastsEnabled is false", async () => {
    setup({ toastsEnabled: false })
    await userEvent.click(screen.getByTestId("error-page-copy-report"))
    await waitFor(() => expect(toastSuccess).not.toHaveBeenCalled())
    setup({
      toastsEnabled: false,
      channelDeps: { writeClipboard: jest.fn().mockRejectedValue(new Error("denied")) },
    })
    await userEvent.click(screen.getAllByTestId("error-page-copy-report")[1])
    await waitFor(() => expect(toastError).not.toHaveBeenCalled())
  })

  it("opens the public tracker pre-filled when no URL is configured", async () => {
    const { openExternal } = setup({ issueReportUrl: undefined })
    await userEvent.click(screen.getByTestId("error-page-report-issue"))
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const url = openExternal.mock.calls[0][0] as string
    expect(url.startsWith(`${ISSUES_URL}/new?`)).toBe(true)
    expect(new URL(url).searchParams.get("title")).toBe("[render] boom")
    expect(new URL(url).searchParams.get("body")).toBe(report.markdown)
  })

  it("prefers the configured tracker and toasts when it cannot be opened", async () => {
    const { openExternal } = setup({ issueReportUrl: "https://github.com/acme/app" })
    await userEvent.click(screen.getByTestId("error-page-report-issue"))
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    expect(openExternal.mock.calls[0][0]).toContain("https://github.com/acme/app/issues/new?")

    setup({ channelDeps: { openExternal: jest.fn().mockRejectedValue(new Error("blocked")) } })
    await userEvent.click(screen.getAllByTestId("error-page-report-issue")[1])
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Tracker failed"))
  })

  it("ignores a second copy click while the first is still building", async () => {
    let release: (value: SupportReport) => void = () => {}
    const build = jest.fn(
      () =>
        new Promise<SupportReport>((resolve) => {
          release = resolve
        })
    )
    const { writeClipboard } = setup({ build })
    const button = screen.getByTestId("error-page-copy-report")
    await userEvent.click(button)
    expect(button).toBeDisabled()
    release(report)
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(1))
    expect(build).toHaveBeenCalledTimes(1)
  })
})
