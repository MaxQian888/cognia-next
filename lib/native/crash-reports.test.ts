/**
 * @jest-environment node
 *
 * Tests for native/crash-reports — invoke wrappers for the Rust crash-report
 * commands. Off the desktop runtime they must be inert.
 */

import { invoke } from "@tauri-apps/api/core"

let isTauriValue = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

import {
  listCrashReports,
  readCrashReport,
  openCrashReportDir,
  deleteCrashReport,
  takePendingCrash,
} from "./crash-reports"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  isTauriValue = false
  mockedInvoke.mockReset()
})

describe("off the desktop runtime", () => {
  it("returns inert defaults without invoking", async () => {
    expect(await listCrashReports()).toEqual([])
    expect(await readCrashReport("x")).toBeNull()
    expect(await openCrashReportDir()).toBe(false)
    expect(await deleteCrashReport("x")).toBe(false)
    expect(await takePendingCrash()).toBeNull()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})

describe("under Tauri", () => {
  beforeEach(() => {
    isTauriValue = true
  })

  it("lists reports from the backend", async () => {
    const rows = [
      {
        stem: "crash-2026-05-25_00-00-00-panic",
        capturedAt: "2026-05-25T00:00:00Z",
        kind: "panic",
        hasTxt: true,
        hasJson: true,
        hasDmp: false,
        sizeBytes: 1234,
      },
    ]
    mockedInvoke.mockResolvedValueOnce(rows)
    expect(await listCrashReports()).toEqual(rows)
    expect(mockedInvoke).toHaveBeenCalledWith("crash_list_reports")
  })

  it("returns [] when the list invoke rejects", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("boom"))
    expect(await listCrashReports()).toEqual([])
  })

  it("reads a report by stem", async () => {
    mockedInvoke.mockResolvedValueOnce("---- Cognia Crash Report ----")
    const text = await readCrashReport("crash-x-panic")
    expect(text).toContain("Cognia Crash Report")
    expect(mockedInvoke).toHaveBeenCalledWith("crash_read_report", { stem: "crash-x-panic" })
  })

  it("deletes by stem", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    expect(await deleteCrashReport("crash-x-panic")).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith("crash_delete_report", { stem: "crash-x-panic" })
  })

  it("opens the report directory", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    expect(await openCrashReportDir()).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith("crash_open_report_dir")
  })

  it("takes the pending crash signal", async () => {
    const pending = {
      startedAt: "2026-05-25T00:00:00Z",
      version: "0.1.0",
      latestReportStem: "crash-x-native",
      reportCount: 2,
    }
    mockedInvoke.mockResolvedValueOnce(pending)
    expect(await takePendingCrash()).toEqual(pending)
    expect(mockedInvoke).toHaveBeenCalledWith("crash_take_pending")
  })

  it("returns null when take_pending rejects", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("state_poisoned"))
    expect(await takePendingCrash()).toBeNull()
  })
})
