const platform = { tauri: false, capacitor: false }
jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => platform.tauri,
  isCapacitor: () => platform.capacitor,
}))
const writeClipboardText = jest.fn(async (_t: string) => undefined)
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (t: string) => writeClipboardText(t),
}))
const downloadFile = jest.fn((..._args: unknown[]) => undefined)
jest.mock("@/lib/files/download", () => ({
  downloadFile: (...args: unknown[]) => downloadFile(...args),
}))
const openExternal = jest.fn(async (_u: string) => undefined)
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (u: string) => openExternal(u),
}))

import { ISSUES_URL } from "@/lib/constants/external-urls"

import {
  __resetSupportReportChannelsForTesting,
  createBuiltinSupportReportChannels,
  deliverSupportReport,
  listAvailableSupportReportChannels,
  listSupportReportChannels,
  registerSupportReportChannel,
} from "./channels"
import type { SupportReport, SupportReportChannelSpec } from "./types"

const report: SupportReport = {
  title: "[render] boom",
  markdown: "## Cognia support report\n",
  filename: "cognia-support-report-2026-08-16.md",
  generatedAt: "2026-08-16T10:00:00.000Z",
  sectionIds: ["app"],
}

const nav = globalThis.navigator as { clipboard?: unknown }
const originalClipboard = nav?.clipboard

beforeEach(() => {
  platform.tauri = false
  platform.capacitor = false
  __resetSupportReportChannelsForTesting()
  writeClipboardText.mockClear()
  downloadFile.mockClear()
  openExternal.mockClear()
})

afterEach(() => {
  if (nav) Object.defineProperty(nav, "clipboard", { configurable: true, value: originalClipboard })
})

describe("built-in channels", () => {
  it("lists copy / download / issue with issue as the primary", () => {
    const ids = listSupportReportChannels().map((c) => c.id)
    expect(ids).toEqual(["copy", "download", "issue"])
    expect(listSupportReportChannels().find((c) => c.primary)?.id).toBe("issue")
  })

  it("copy is available on native shells or when navigator.clipboard.writeText exists", () => {
    const copy = createBuiltinSupportReportChannels().find((c) => c.id === "copy")!
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: undefined },
    })
    expect(copy.isAvailable()).toBe(false)
    platform.capacitor = true
    expect(copy.isAvailable()).toBe(true)
    platform.capacitor = false
    platform.tauri = true
    expect(copy.isAvailable()).toBe(true)
    platform.tauri = false
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async () => undefined } },
    })
    expect(copy.isAvailable()).toBe(true)
  })

  it("download needs a document; issue is always available", () => {
    const channels = createBuiltinSupportReportChannels()
    expect(channels.find((c) => c.id === "download")!.isAvailable()).toBe(
      typeof document !== "undefined"
    )
    expect(channels.find((c) => c.id === "issue")!.isAvailable()).toBe(true)
  })

  it("delivers through the real shell IO by default", async () => {
    await deliverSupportReport("copy", report)
    expect(writeClipboardText).toHaveBeenCalledWith(report.markdown)

    await deliverSupportReport("download", report)
    expect(downloadFile).toHaveBeenCalledWith(
      report.filename,
      report.markdown,
      "text/markdown;charset=utf-8"
    )

    await deliverSupportReport("issue", report)
    const url = openExternal.mock.calls[0][0]
    expect(url.startsWith(`${ISSUES_URL}/new?`)).toBe(true)
    expect(new URL(url).searchParams.get("title")).toBe(report.title)
  })

  it("honours injected seams and the configured tracker", async () => {
    const writeClipboard = jest.fn(async () => undefined)
    const download = jest.fn()
    const open = jest.fn(async (_url: string) => undefined)
    const deps = {
      writeClipboard,
      download,
      openExternal: open,
      issueTrackerUrl: "https://github.com/acme/app",
    }
    await deliverSupportReport("copy", report, deps)
    await deliverSupportReport("download", report, deps)
    await deliverSupportReport("issue", report, deps)
    expect(writeClipboard).toHaveBeenCalledWith(report.markdown)
    expect(download).toHaveBeenCalledWith(report.filename, report.markdown, expect.any(String))
    expect(open.mock.calls[0][0]).toMatch(/^https:\/\/github\.com\/acme\/app\/issues\/new\?/)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it("throws for an unknown channel", async () => {
    await expect(deliverSupportReport("nope", report)).rejects.toThrow(/nope/)
  })
})

describe("registry", () => {
  const custom: SupportReportChannelSpec = {
    id: "team-inbox",
    labelKey: "teamInbox",
    isAvailable: () => true,
    deliver: jest.fn(async () => undefined),
  }

  it("appends registrations, lists only available ones, and delivers to them (with or without deps)", async () => {
    const off = registerSupportReportChannel(custom)
    const hidden = registerSupportReportChannel({
      ...custom,
      id: "hidden",
      isAvailable: () => false,
    })
    expect(listSupportReportChannels().map((c) => c.id)).toEqual([
      "copy",
      "download",
      "issue",
      "team-inbox",
      "hidden",
    ])
    expect(listAvailableSupportReportChannels().map((c) => c.id)).not.toContain("hidden")
    await deliverSupportReport("team-inbox", report)
    await deliverSupportReport("team-inbox", report, {})
    expect(custom.deliver).toHaveBeenCalledTimes(2)
    off()
    hidden()
    expect(listSupportReportChannels().some((c) => c.id === "team-inbox")).toBe(false)
  })

  it("refuses duplicate ids and ignores a stale unregister handle", () => {
    expect(() => registerSupportReportChannel({ ...custom, id: "copy" })).toThrow(/copy/)
    const off = registerSupportReportChannel(custom)
    expect(() => registerSupportReportChannel(custom)).toThrow(/team-inbox/)
    off()
    const again = registerSupportReportChannel({ ...custom })
    off()
    expect(listSupportReportChannels().some((c) => c.id === "team-inbox")).toBe(true)
    again()
  })
})
