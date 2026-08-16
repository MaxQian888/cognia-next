/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const buildSupportReport = jest.fn(async (..._args: unknown[]) => ({
  title: "Cognia support report",
  markdown: "## Cognia support report\n",
  filename: "cognia-support-report.md",
  generatedAt: "2026-08-16T00:00:00.000Z",
  sectionIds: ["app"],
}))
jest.mock("@/lib/support-report/build", () => ({
  buildSupportReport: (...args: unknown[]) => buildSupportReport(...args),
}))
const deliverSupportReport = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/support-report/channels", () => ({
  deliverSupportReport: (...args: unknown[]) => deliverSupportReport(...args),
}))
jest.mock("@/components/support/report-problem-dialog", () => ({
  ReportProblemDialog: ({ open, context }: { open?: boolean; context: { surface: string } }) => (
    <div
      data-testid="report-problem-dialog"
      data-open={String(open)}
      data-surface={context.surface}
    />
  ),
}))

const toastMock = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastMock.success(m),
    error: (m: string) => toastMock.error(m),
  },
}))

import Page from "./page"

describe("MobileFeedbackPage", () => {
  beforeEach(() => {
    toastMock.success.mockReset()
    toastMock.error.mockReset()
    buildSupportReport.mockClear()
    deliverSupportReport.mockClear()
  })

  it("renders the open-issue row pointing at the tracker's new-issue endpoint", () => {
    render(<Page />)
    expect(screen.getByTestId("feedback-row-open-issue")).toHaveAttribute(
      "href",
      "https://github.com/MaxQian888/cognia-next/issues/new"
    )
  })

  it("opens the unified report dialog for the mobile surface", () => {
    render(<Page />)
    const dialog = screen.getByTestId("report-problem-dialog")
    expect(dialog).toHaveAttribute("data-open", "false")
    expect(dialog).toHaveAttribute("data-surface", "mobile")
    fireEvent.click(screen.getByTestId("feedback-row-report-problem"))
    expect(dialog).toHaveAttribute("data-open", "true")
  })

  it("copies the default redacted report through the copy channel", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("feedback-row-copy"))
    await waitFor(() => expect(deliverSupportReport).toHaveBeenCalledTimes(1))
    expect(buildSupportReport).toHaveBeenCalledWith({ context: { surface: "mobile" } })
    expect(deliverSupportReport).toHaveBeenCalledWith(
      "copy",
      expect.objectContaining({ markdown: expect.stringContaining("Cognia support report") })
    )
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("copyToast"))
  })

  it("falls back to an error toast when the clipboard write fails", async () => {
    deliverSupportReport.mockRejectedValueOnce(new Error("no clipboard"))
    render(<Page />)
    fireEvent.click(screen.getByTestId("feedback-row-copy"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("copyError"))
  })

  it("renders the device-info shortcut", () => {
    render(<Page />)
    expect(screen.getByTestId("feedback-row-device-info")).toHaveAttribute(
      "href",
      "/me/device-info"
    )
  })
})
