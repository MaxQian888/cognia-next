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
  formatDiagnostics,
  gatherDiagnostics,
  openDataFolder,
  openDocs,
  reportIssue,
  toggleAutostartAction,
  type DiagnosticsFacts,
} from "./tray-actions"
import { DOCS_URL, ISSUES_URL } from "@/lib/constants/external-urls"
import { APP_VERSION } from "@/lib/app-version"

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

describe("formatDiagnostics", () => {
  it("renders a labelled block with the header line", () => {
    const text = formatDiagnostics(facts())
    expect(text.split("\n")[0]).toBe("Cognia 1.2.3 (stable)")
    expect(text).toContain("Commit:   abc1234")
    expect(text).toContain("Tauri:    2.9.0")
    expect(text).toContain("Engine:   Chromium 130")
  })

  it("substitutes an em-dash for empty / null fields", () => {
    const text = formatDiagnostics(facts({ commit: "", tauri: null, engine: null }))
    expect(text).toContain("Commit:   —")
    expect(text).toContain("Tauri:    —")
    expect(text).toContain("Engine:   —")
  })
})

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

  it("reportIssue → ISSUES_URL", async () => {
    const openExternal = jest.fn().mockResolvedValue(undefined)
    await reportIssue({ openExternal })
    expect(openExternal).toHaveBeenCalledWith(ISSUES_URL)
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

describe("gatherDiagnostics (live)", () => {
  it("collects the running app facts from app-metadata", async () => {
    const facts = await gatherDiagnostics()
    expect(facts.name).toBe("Cognia")
    expect(facts.version).toBe(APP_VERSION)
    // Web/jsdom test env: not Tauri, so the Tauri version resolves to null.
    expect(facts.tauri).toBeNull()
    expect(typeof facts.react).toBe("string")
    expect(typeof facts.platform).toBe("string")
    // The gathered facts must render without throwing.
    expect(formatDiagnostics(facts)).toContain(`Cognia ${APP_VERSION}`)
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
    await reportIssue()
    expect(openExternalMock).toHaveBeenCalledWith(ISSUES_URL)
    // No deps → real checkForUpdate, which no-ops to `null` off the desktop
    // shell (jsdom is not Tauri), so the tray reports "up to date".
    await expect(checkUpdates()).resolves.toEqual({ kind: "upToDate" })
    await expect(toggleAutostartAction()).resolves.toBe(true)
    expect(toggleTrayAutostartMock).toHaveBeenCalledTimes(1)
  })
})
