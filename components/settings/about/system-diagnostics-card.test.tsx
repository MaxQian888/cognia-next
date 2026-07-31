/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { OsInfo } from "@/lib/tauri/os"

jest.mock("@/lib/app-metadata", () => ({ APP_NAME: "Cognia", APP_VERSION: "9.9.9" }))

const writeClipboardTextMock = jest.fn(async (_t: string) => {})
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (t: string) => writeClipboardTextMock(t),
}))

const revealInExplorerMock = jest.fn(async (_p: string) => {})
jest.mock("@/lib/tauri/opener", () => ({
  revealInExplorer: (p: string) => revealInExplorerMock(p),
  openExternal: jest.fn(),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

import { toast } from "sonner"
import { SystemDiagnosticsCard } from "./system-diagnostics-card"

const toastMock = toast as unknown as {
  success: jest.Mock
  error: jest.Mock
  info: jest.Mock
}

const OS: OsInfo = {
  platform: "windows",
  osType: "Windows",
  family: "windows",
  arch: "x86_64",
  version: "11",
  hostname: "host",
  locale: "en-US",
}

beforeEach(() => {
  jest.clearAllMocks()
  writeClipboardTextMock.mockResolvedValue(undefined)
  revealInExplorerMock.mockResolvedValue(undefined)
})

const CRASH_DIAG = {
  crashReportCount: 2,
  latestCrashAt: "2026-06-10T08:00:00Z",
  latestCrashKind: "panic",
  logDirBytes: 3 * 1024 * 1024,
  retentionMaxAgeDays: 30,
  retentionMaxReports: 50,
  rotatedLogKeep: 5,
  lastPrunePruned: 1,
  lastPruneRemaining: 2,
}

const NATIVE_LOGGING = {
  startupMode: "full",
  startupHealth: "healthy",
} as unknown as Awaited<
  ReturnType<typeof import("@/lib/native/native-logging").getNativeLoggingReadiness>
>

function renderWithData() {
  return render(
    <SystemDiagnosticsCard
      osLoader={async () => OS}
      dataDirLoader={async () => "C:/Users/me/cognia"}
      diagnosticsLoader={async () => CRASH_DIAG}
      nativeLoggingLoader={async () => NATIVE_LOGGING}
    />
  )
}

describe("<SystemDiagnosticsCard />", () => {
  it("renders OS, arch, locale and data dir", async () => {
    renderWithData()
    await waitFor(() => expect(screen.getByTestId("row-os")).toHaveTextContent("Windows 11"))
    expect(screen.getByTestId("row-arch")).toHaveTextContent("x86_64")
    expect(screen.getByTestId("row-locale")).toHaveTextContent("en-US")
    expect(screen.getByTestId("row-data-dir")).toHaveTextContent("C:/Users/me/cognia")
  })

  it("copies a diagnostics bundle to the clipboard", async () => {
    renderWithData()
    await waitFor(() => screen.getByTestId("row-data-dir"))
    fireEvent.click(screen.getByTestId("copy-diagnostics"))
    await waitFor(() => expect(writeClipboardTextMock).toHaveBeenCalledTimes(1))
    const text = writeClipboardTextMock.mock.calls[0]![0]
    expect(text).toContain("App: Cognia 9.9.9")
    expect(text).toContain("OS: Windows 11")
    expect(text).toContain("Data dir: C:/Users/me/cognia")
    expect(toastMock.success).toHaveBeenCalled()
  })

  it("surfaces a copy failure via toast", async () => {
    writeClipboardTextMock.mockRejectedValueOnce(new Error("denied"))
    renderWithData()
    await waitFor(() => screen.getByTestId("copy-diagnostics"))
    fireEvent.click(screen.getByTestId("copy-diagnostics"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it("reveals the data directory", async () => {
    renderWithData()
    await waitFor(() => screen.getByTestId("reveal-data-dir"))
    fireEvent.click(screen.getByTestId("reveal-data-dir"))
    await waitFor(() => expect(revealInExplorerMock).toHaveBeenCalledWith("C:/Users/me/cognia"))
  })

  it("degrades gracefully with no OS info or data dir", async () => {
    render(
      <SystemDiagnosticsCard
        osLoader={async () => null}
        dataDirLoader={async () => null}
        diagnosticsLoader={async () => null}
        nativeLoggingLoader={async () => null}
      />
    )
    await waitFor(() => expect(screen.getByTestId("row-locale-fallback")).toBeInTheDocument())
    expect(screen.queryByTestId("reveal-data-dir")).not.toBeInTheDocument()
    expect(screen.getByTestId("copy-diagnostics")).toBeInTheDocument()
  })

  it("renders the crash & logs section with retention + native logging", async () => {
    renderWithData()
    await waitFor(() => expect(screen.getByTestId("row-crash-count")).toHaveTextContent("2"))
    expect(screen.getByTestId("row-global-error-handlers")).toBeInTheDocument()
    expect(screen.getByTestId("row-last-crash")).toHaveTextContent("2026-06-10T08:00:00Z")
    expect(screen.getByTestId("row-log-footprint")).toHaveTextContent("3.0 MB")
    expect(screen.getByTestId("row-retention")).toBeInTheDocument()
    expect(screen.getByTestId("row-native-logging")).toHaveTextContent("full / healthy")
  })

  it("shows the unavailable fallback when diagnostics are absent (web)", async () => {
    render(
      <SystemDiagnosticsCard
        osLoader={async () => OS}
        dataDirLoader={async () => null}
        diagnosticsLoader={async () => null}
        nativeLoggingLoader={async () => null}
      />
    )
    await waitFor(() => expect(screen.getByTestId("row-crash-unavailable")).toBeInTheDocument())
    expect(screen.getByTestId("row-global-error-handlers")).toBeInTheDocument()
  })

  it("includes crash + log facts in the copied bundle", async () => {
    renderWithData()
    await waitFor(() => screen.getByTestId("row-crash-count"))
    fireEvent.click(screen.getByTestId("copy-diagnostics"))
    await waitFor(() => expect(writeClipboardTextMock).toHaveBeenCalledTimes(1))
    const text = writeClipboardTextMock.mock.calls[0]![0]
    expect(text).toContain("Crash reports: 2")
    expect(text).toContain("Log footprint: 3.0 MB")
    expect(text).toContain("Native logging: full / healthy")
  })
})
