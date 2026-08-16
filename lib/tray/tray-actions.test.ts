const openExternalMock = jest.fn().mockResolvedValue(undefined)
const revealMock = jest.fn().mockResolvedValue(undefined)
const writeClipboardMock = jest.fn().mockResolvedValue(undefined)
const toggleTrayAutostartMock = jest.fn().mockResolvedValue(true)

jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (url: string) => openExternalMock(url),
  revealInExplorer: (p: string) => revealMock(p),
}))
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (t: string) => writeClipboardMock(t),
}))
jest.mock("./autostart-control", () => ({
  toggleTrayAutostart: () => toggleTrayAutostartMock(),
}))

import {
  checkUpdates,
  copyDiagnostics,
  openDataFolder,
  openDocs,
  reportIssue,
  toggleAutostartAction,
} from "./tray-actions"
import { DOCS_URL } from "@/lib/constants/external-urls"
import { useUIStore } from "@/stores/ui"
import type { DiagnosticsFacts } from "@/lib/support-report/app-facts"

beforeEach(() => {
  openExternalMock.mockClear()
  revealMock.mockClear()
  writeClipboardMock.mockClear()
  toggleTrayAutostartMock.mockClear()
})

function facts(overrides: Partial<DiagnosticsFacts> = {}): DiagnosticsFacts {
  return {
    name: "Cognia",
    version: "1.2.3",
    channel: "stable",
    commit: "abc1234",
    buildTime: "2026-06-11T00:00:00Z",
    tauri: "2.9.0",
    react: "19.0.0",
    engine: "Chromium 130",
    platform: "Win32",
    ...overrides,
  }
}

describe("openDataFolder", () => {
  it("reveals the resolved app-data directory", async () => {
    const reveal = jest.fn().mockResolvedValue(undefined)
    await openDataFolder({ appDataDir: async () => "C:/data/cognia", reveal })
    expect(reveal).toHaveBeenCalledWith("C:/data/cognia")
  })
})

describe("copyDiagnostics", () => {
  it("formats the gathered facts and writes them to the clipboard", async () => {
    const writeClipboard = jest.fn().mockResolvedValue(undefined)
    const text = await copyDiagnostics({
      gather: async () => facts({ version: "9.9.9" }),
      writeClipboard,
    })
    expect(text).toContain("Cognia 9.9.9 (stable)")
    expect(writeClipboard).toHaveBeenCalledWith(text)
  })
})

describe("outbound links", () => {
  it("openDocs → DOCS_URL", async () => {
    const openExternal = jest.fn().mockResolvedValue(undefined)
    await openDocs({ openExternal })
    expect(openExternal).toHaveBeenCalledWith(DOCS_URL)
  })

  it("reportIssue → the injected report request, never a bare tracker link", async () => {
    const requestReport = jest.fn()
    const openExternal = jest.fn().mockResolvedValue(undefined)
    await reportIssue({ requestReport, openExternal })
    expect(requestReport).toHaveBeenCalledTimes(1)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("reportIssue with no deps raises the tray report request on the UI store", async () => {
    await reportIssue()
    expect(useUIStore.getState().pendingReportRequest).toEqual({
      context: { surface: "tray" },
      nonce: 1,
    })
  })

  it("checkUpdates → 'available' when the injected check finds a newer release", async () => {
    const check = jest.fn().mockResolvedValue({ version: "9.9.9" })
    await expect(checkUpdates({ check })).resolves.toEqual({ kind: "available", version: "9.9.9" })
  })

  it("checkUpdates → 'upToDate' when the injected check finds nothing", async () => {
    const check = jest.fn().mockResolvedValue(null)
    await expect(checkUpdates({ check })).resolves.toEqual({ kind: "upToDate" })
  })

  it("checkUpdates → 'error' (never throws) when the check rejects", async () => {
    const check = jest.fn().mockRejectedValue(new Error("offline"))
    await expect(checkUpdates({ check })).resolves.toEqual({ kind: "error", message: "offline" })
  })

  it("checkUpdates stringifies a non-Error rejection", async () => {
    const check = jest.fn().mockRejectedValue("boom")
    await expect(checkUpdates({ check })).resolves.toEqual({ kind: "error", message: "boom" })
  })
})

describe("toggleAutostartAction", () => {
  it("delegates to the injected toggle and returns its result", async () => {
    const toggleAutostart = jest.fn().mockResolvedValue(true)
    await expect(toggleAutostartAction({ toggleAutostart })).resolves.toBe(true)
    expect(toggleAutostart).toHaveBeenCalledTimes(1)
  })
})

describe("default IO paths", () => {
  it("copyDiagnostics with no deps gathers live facts and writes the clipboard", async () => {
    const text = await copyDiagnostics()
    expect(text).toContain("Cognia ")
    expect(writeClipboardMock).toHaveBeenCalledWith(text)
  })

  it("openDataFolder resolves the app-data dir via the path plugin", async () => {
    jest.doMock("@tauri-apps/api/path", () => ({ appDataDir: async () => "/tmp/cognia" }), {
      virtual: true,
    })
    const reveal = jest.fn().mockResolvedValue(undefined)
    await openDataFolder({ reveal })
    expect(reveal).toHaveBeenCalledWith("/tmp/cognia")
    jest.dontMock("@tauri-apps/api/path")
  })

  it("falls back to the real opener / autostart when no deps are passed", async () => {
    await openDocs()
    expect(openExternalMock).toHaveBeenCalledWith(DOCS_URL)
    // No deps → real checkForUpdate, which no-ops to `null` off the desktop
    // shell (jsdom is not Tauri), so the tray reports "up to date".
    await expect(checkUpdates()).resolves.toEqual({ kind: "upToDate" })
    await expect(toggleAutostartAction()).resolves.toBe(true)
    expect(toggleTrayAutostartMock).toHaveBeenCalledTimes(1)
  })
})
