/**
 * @jest-environment jsdom
 */

import { exportCrashLogBundleNow } from "./crash-log"
import {
  getRecentErrorLogs,
  recordRecentErrorLog,
  resetRecentErrorLogsForTest,
} from "./recent-errors"

jest.mock("./bootstrap", () => ({
  getIndexedDBTransport: jest.fn(),
}))

jest.mock("@/lib/native/native-logging", () => ({
  getNativeLoggingReadiness: jest.fn(async () => undefined),
  getNativeLoggingReadinessSnapshot: jest.fn(() => null),
  getNativeLogDirectory: jest.fn(async () => null),
}))

jest.mock("@/lib/native/local-runtime", () => ({
  getLocalRuntimeDiagnostics: jest.fn(async () => null),
}))

jest.mock("@/lib/native/window-diagnostics", () => ({
  getWindowDiagnostics: jest.fn(async () => null),
}))

jest.mock("@/lib/files/download", () => ({
  downloadFile: jest.fn(),
}))

import { getIndexedDBTransport } from "./bootstrap"
import { downloadFile } from "@/lib/files/download"
import { getNativeLoggingReadiness } from "@/lib/native/native-logging"

const downloadFileMock = downloadFile as jest.MockedFunction<typeof downloadFile>
const getIndexedDBTransportMock = getIndexedDBTransport as jest.MockedFunction<
  typeof getIndexedDBTransport
>
const getNativeLoggingReadinessMock = getNativeLoggingReadiness as jest.MockedFunction<
  typeof getNativeLoggingReadiness
>

beforeEach(() => {
  resetRecentErrorLogsForTest()
  downloadFileMock.mockReset()
  getIndexedDBTransportMock.mockReset()
  getNativeLoggingReadinessMock.mockReset()
  getNativeLoggingReadinessMock.mockResolvedValue(undefined as never)
})

describe("exportCrashLogBundleNow", () => {
  it("downloads a bundle containing the injected trigger error", async () => {
    const triggerError = Object.assign(new Error("kaboom"), { digest: "abc123" })

    await exportCrashLogBundleNow({ triggerError, subsystem: "scheduler" })

    expect(downloadFileMock).toHaveBeenCalledTimes(1)
    const [filename, content, mimeType] = downloadFileMock.mock.calls[0]
    expect(filename).toMatch(/^cognia-crash-bundle-\d{4}-\d{2}-\d{2}\.json$/)
    expect(mimeType).toBe("application/json")

    const parsed = JSON.parse(content as string)
    const titles = parsed.items.map((i: { title: string }) => i.title)
    expect(titles).toContain("kaboom")

    const matching = parsed.items.find((i: { title: string }) => i.title === "kaboom")
    expect(matching.logEntry.module).toBe("scheduler")
    expect(matching.logEntry.data?.digest).toBe("abc123")
  })

  it("includes recently-recorded errors that pre-date the export call", async () => {
    recordRecentErrorLog({
      id: "prior-error",
      timestamp: "2026-04-29T00:00:00.000Z",
      level: "error",
      module: "ui",
      message: "earlier failure",
      origin: "frontend",
    })

    await exportCrashLogBundleNow()

    expect(getRecentErrorLogs().map((e) => e.id)).toContain("prior-error")
    const [, content] = downloadFileMock.mock.calls[0]
    const parsed = JSON.parse(content as string)
    expect(parsed.items.map((i: { id: string }) => i.id)).toContain("prior-error")
  })

  it("falls back to an empty persisted list when IndexedDB transport throws", async () => {
    getIndexedDBTransportMock.mockReturnValue({
      getLogs: jest.fn(async () => {
        throw new Error("idb is closed")
      }),
    } as unknown as ReturnType<typeof getIndexedDBTransport>)

    await expect(exportCrashLogBundleNow()).resolves.toBeUndefined()
    expect(downloadFileMock).toHaveBeenCalledTimes(1)
  })

  it("records the diagnostics error message when native readiness rejects", async () => {
    getNativeLoggingReadinessMock.mockRejectedValueOnce(new Error("bridge offline"))

    await exportCrashLogBundleNow()

    const [, content] = downloadFileMock.mock.calls[0]
    const parsed = JSON.parse(content as string)
    expect(parsed.diagnostics?.diagnosticsError).toBe("bridge offline")
  })

  it("honors a caller-supplied filename and format", async () => {
    await exportCrashLogBundleNow({ filename: "custom-name.txt", format: "text" })

    const [filename, , mimeType] = downloadFileMock.mock.calls[0]
    expect(filename).toBe("custom-name.txt")
    expect(mimeType).toBe("text/plain")
  })
})
