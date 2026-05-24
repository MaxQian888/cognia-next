/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const listCrashReportsMock = jest.fn()
const readCrashReportMock = jest.fn()
const openCrashReportDirMock = jest.fn()
const deleteCrashReportMock = jest.fn()
jest.mock("@/lib/native/crash-reports", () => ({
  listCrashReports: () => listCrashReportsMock(),
  readCrashReport: (stem: string) => readCrashReportMock(stem),
  openCrashReportDir: () => openCrashReportDirMock(),
  deleteCrashReport: (stem: string) => deleteCrashReportMock(stem),
}))

import { NativeCrashReportsCard } from "./native-crash-reports-card"

const sampleRows = [
  {
    stem: "crash-2026-05-25_10-00-00-panic",
    capturedAt: "2026-05-25T10:00:00Z",
    kind: "panic",
    hasTxt: true,
    hasJson: true,
    hasDmp: false,
    sizeBytes: 2048,
  },
  {
    stem: "crash-2026-05-25_11-00-00-native",
    capturedAt: "2026-05-25T11:00:00Z",
    kind: "native",
    hasTxt: true,
    hasJson: true,
    hasDmp: true,
    sizeBytes: 1024 * 1024,
  },
]

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  listCrashReportsMock.mockResolvedValue([])
})

it("shows a desktop-only note and does not query off the desktop runtime", () => {
  isTauriMock.mockReturnValue(false)
  render(<NativeCrashReportsCard />)
  expect(screen.getByText("settings.diagnostics.crashReports.desktopOnly")).toBeInTheDocument()
  expect(listCrashReportsMock).not.toHaveBeenCalled()
})

it("lists reports from the backend on mount", async () => {
  listCrashReportsMock.mockResolvedValue(sampleRows)
  render(<NativeCrashReportsCard />)
  await waitFor(() => expect(screen.getAllByTestId("crash-report-row")).toHaveLength(2))
  expect(screen.getByText("settings.diagnostics.crashReports.kindNative")).toBeInTheDocument()
  expect(screen.getByText("settings.diagnostics.crashReports.kindPanic")).toBeInTheDocument()
})

it("renders the empty state when there are no reports", async () => {
  listCrashReportsMock.mockResolvedValue([])
  render(<NativeCrashReportsCard />)
  await waitFor(() =>
    expect(screen.getByText("settings.diagnostics.crashReports.empty")).toBeInTheDocument()
  )
})

it("opens the report directory", async () => {
  openCrashReportDirMock.mockResolvedValue(true)
  render(<NativeCrashReportsCard />)
  await waitFor(() => expect(listCrashReportsMock).toHaveBeenCalled())
  fireEvent.click(screen.getByText("settings.diagnostics.crashReports.openFolder"))
  expect(openCrashReportDirMock).toHaveBeenCalled()
})

it("views a report's text in a dialog", async () => {
  listCrashReportsMock.mockResolvedValue(sampleRows)
  readCrashReportMock.mockResolvedValue("---- Cognia Crash Report ----\nDescription: boom")
  render(<NativeCrashReportsCard />)
  await waitFor(() => expect(screen.getAllByTestId("crash-report-row")).toHaveLength(2))
  const viewButtons = screen.getAllByLabelText("settings.diagnostics.crashReports.view")
  fireEvent.click(viewButtons[0])
  await waitFor(() => expect(readCrashReportMock).toHaveBeenCalledWith(sampleRows[0].stem))
  expect(await screen.findByText(/Description: boom/)).toBeInTheDocument()
})

it("deletes a report then refreshes the list", async () => {
  listCrashReportsMock.mockResolvedValueOnce(sampleRows).mockResolvedValueOnce([sampleRows[1]])
  deleteCrashReportMock.mockResolvedValue(true)
  render(<NativeCrashReportsCard />)
  await waitFor(() => expect(screen.getAllByTestId("crash-report-row")).toHaveLength(2))
  const deleteButtons = screen.getAllByLabelText("settings.diagnostics.crashReports.delete")
  fireEvent.click(deleteButtons[0])
  await waitFor(() => expect(deleteCrashReportMock).toHaveBeenCalledWith(sampleRows[0].stem))
  await waitFor(() => expect(screen.getAllByTestId("crash-report-row")).toHaveLength(1))
})
