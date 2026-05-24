/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${ns}.${key}(${JSON.stringify(vars)})` : `${ns}.${key}`,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const takePendingCrashMock = jest.fn()
const readCrashReportMock = jest.fn()
const openCrashReportDirMock = jest.fn()
jest.mock("@/lib/native/crash-reports", () => ({
  takePendingCrash: () => takePendingCrashMock(),
  readCrashReport: (stem: string) => readCrashReportMock(stem),
  openCrashReportDir: () => openCrashReportDirMock(),
}))

import { CrashReportDialog } from "./crash-report-dialog"

const pending = {
  startedAt: "2026-05-25T10:00:00Z",
  version: "0.1.0",
  latestReportStem: "crash-2026-05-25_10-00-00-native",
  reportCount: 1,
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  takePendingCrashMock.mockResolvedValue(null)
})

it("renders nothing off the desktop runtime", () => {
  isTauriMock.mockReturnValue(false)
  const { container } = render(<CrashReportDialog />)
  expect(container).toBeEmptyDOMElement()
  expect(takePendingCrashMock).not.toHaveBeenCalled()
})

it("renders nothing when there is no pending crash", async () => {
  takePendingCrashMock.mockResolvedValue(null)
  render(<CrashReportDialog />)
  await waitFor(() => expect(takePendingCrashMock).toHaveBeenCalled())
  expect(screen.queryByText("crashDialog.title")).not.toBeInTheDocument()
})

it("surfaces the dialog when a previous crash is pending", async () => {
  takePendingCrashMock.mockResolvedValue(pending)
  render(<CrashReportDialog />)
  expect(await screen.findByText("crashDialog.title")).toBeInTheDocument()
})

it("loads the report text when View report is clicked", async () => {
  takePendingCrashMock.mockResolvedValue(pending)
  readCrashReportMock.mockResolvedValue("---- Cognia Crash Report ----\nKind: Native crash")
  render(<CrashReportDialog />)
  await screen.findByText("crashDialog.title")
  fireEvent.click(screen.getByText("crashDialog.viewReport"))
  await waitFor(() => expect(readCrashReportMock).toHaveBeenCalledWith(pending.latestReportStem))
  expect(await screen.findByText(/Kind: Native crash/)).toBeInTheDocument()
})

it("opens the reports folder", async () => {
  takePendingCrashMock.mockResolvedValue(pending)
  openCrashReportDirMock.mockResolvedValue(true)
  render(<CrashReportDialog />)
  await screen.findByText("crashDialog.title")
  fireEvent.click(screen.getByText("crashDialog.openFolder"))
  expect(openCrashReportDirMock).toHaveBeenCalled()
})

it("dismisses and consumes the signal so it does not reappear", async () => {
  takePendingCrashMock.mockResolvedValue(pending)
  render(<CrashReportDialog />)
  await screen.findByText("crashDialog.title")
  fireEvent.click(screen.getByText("crashDialog.dismiss"))
  await waitFor(() => expect(screen.queryByText("crashDialog.title")).not.toBeInTheDocument())
})
